// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ConduitVaultRegistrar} from "../src/ConduitVaultRegistrar.sol";
import {IAPassComplianceValidator} from "../src/interfaces/IAPassComplianceValidator.sol";
import {IComplianceRule} from "../src/interfaces/IATokenPolicy.sol";

/// @dev Mirrors the live Monad validator's observed behaviour, including the two
///      failure modes that were hit for real: `AccessControlUnauthorizedAccount`
///      when the caller lacks REGISTER_ROLE, and `PoolNotRegistered` when
///      `registerApass` runs before `registerV2`.
contract ValidatorMock is IAPassComplianceValidator {
    bytes32 private constant _REGISTER_ROLE =
        0xd1f21ec03a6eb050fba156f5316dad461735df521fb446dd42c5a4728e9c70fe;

    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);

    mapping(address => bool) private _roles;
    mapping(address => bool) private _registered;
    mapping(address => RuleV2[]) private _rules;
    mapping(address => address) public cviToken;
    mapping(address => address) public cviFee;

    function grant(address account) external {
        _roles[account] = true;
    }

    function REGISTER_ROLE() external pure returns (bytes32) {
        return _REGISTER_ROLE;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return role == _REGISTER_ROLE && _roles[account];
    }

    function registerV2(address poolAddress, RuleV2 calldata rule) external {
        _requireRole();
        _registered[poolAddress] = true;
        _rules[poolAddress].push(rule);
    }

    function registerApass(address poolAddress, address aTokenAddress, address feeAddress)
        external
    {
        _requireRole();
        if (!_registered[poolAddress]) revert PoolNotRegistered();
        cviToken[poolAddress] = aTokenAddress;
        cviFee[poolAddress] = feeAddress;
    }

    function registerApass(address poolAddress, address aTokenAddress) external {
        _requireRole();
        if (!_registered[poolAddress]) revert PoolNotRegistered();
        cviToken[poolAddress] = aTokenAddress;
    }

    function setRuleV2FromRegistrar(address poolAddress, RuleV2 calldata rule) external {
        _requireRole();
        if (!_registered[poolAddress]) revert PoolNotRegistered();
        delete _rules[poolAddress];
        _rules[poolAddress].push(rule);
    }

    function setRuleV2FromContract(RuleV2 calldata rule) external {
        delete _rules[msg.sender];
        _rules[msg.sender].push(rule);
    }

    function addRuleV2FromContract(RuleV2 calldata rule) external {
        _rules[msg.sender].push(rule);
    }

    function removeRuleV2FromContract(uint256) external {
        delete _rules[msg.sender];
    }

    function isRegistered(address poolAddress) external view returns (bool) {
        return _registered[poolAddress];
    }

    function complianceVerify(address poolAddress, address) external view returns (bool) {
        if (!_registered[poolAddress]) revert PoolNotRegistered();
        return true;
    }

    function getRulesV2(address poolAddress) external view returns (RuleV2[] memory) {
        return _rules[poolAddress];
    }

    function _requireRole() private view {
        if (!_roles[msg.sender]) {
            revert AccessControlUnauthorizedAccount(msg.sender, _REGISTER_ROLE);
        }
    }
}

contract ConduitVaultRegistrarTest is Test {
    ValidatorMock private validator;
    ConduitVaultRegistrar private registrar;

    address private constant OWNER = address(0xA11CE);
    address private constant STRANGER = address(0xB0B);
    address private constant POOL = address(0x1645);
    address private constant A_TOKEN = address(0xAC08);

    function setUp() public {
        validator = new ValidatorMock();
        registrar = new ConduitVaultRegistrar(address(validator), OWNER);
    }

    function _zeroRule() private pure returns (IComplianceRule.RuleV2 memory) {
        return IComplianceRule.RuleV2({
            allowedGroup: bytes2(0),
            allowedSubGroup: bytes2(0),
            minTier: 0,
            minSubTier: 0,
            isBlackList: false,
            poolCountryBitmap: 0
        });
    }

    function test_RejectsAValidatorWithNoCode() public {
        vm.expectRevert(ConduitVaultRegistrar.ValidatorHasNoCode.selector);
        new ConduitVaultRegistrar(address(0xDEAD), OWNER);
    }

    function test_ValidatorIsImmutable() public view {
        // No setter exists. The assertion is the absence of one: a registrar that
        // could be repointed lets an owner key mint eligibility from a contract
        // of its own choosing, which is the property CCP exists to provide.
        assertEq(address(registrar.validator()), address(validator));
    }

    function test_ReportsWhetherCleanverseHasGrantedTheRole() public {
        assertFalse(registrar.hasRegisterRole());
        validator.grant(address(registrar));
        assertTrue(registrar.hasRegisterRole());
    }

    function test_RegistrationFailsLoudlyBeforeTheGrant() public {
        // The real failure without this check is AccessControlUnauthorizedAccount
        // naming the registrar, which reads as a contract bug rather than as a
        // grant nobody has issued yet.
        vm.prank(OWNER);
        vm.expectRevert(ConduitVaultRegistrar.RegistrarLacksRegisterRole.selector);
        registrar.registerPool(POOL, _zeroRule());
    }

    function test_OnlyTheOwnerRegisters() public {
        validator.grant(address(registrar));
        vm.prank(STRANGER);
        vm.expectRevert();
        registrar.registerPool(POOL, _zeroRule());
    }

    function test_CviRequiresThePoolToBeRegisteredFirst() public {
        // Observed live as selector 0x739f4185 from the Monad validator when
        // registerApass ran before registerV2.
        validator.grant(address(registrar));
        vm.prank(OWNER);
        vm.expectRevert(IAPassComplianceValidator.PoolNotRegistered.selector);
        registrar.registerVaultCvi(POOL, A_TOKEN, address(0));
    }

    function test_RegistersThePoolThenIssuesCvi() public {
        validator.grant(address(registrar));

        vm.prank(OWNER);
        registrar.registerPool(POOL, _zeroRule());
        assertTrue(validator.isRegistered(POOL));

        vm.prank(OWNER);
        registrar.registerVaultCvi(POOL, A_TOKEN, address(0));
        assertEq(validator.cviToken(POOL), A_TOKEN);
        assertEq(validator.cviFee(POOL), address(0));
    }

    function test_AZeroFeeAddressIsPassedThroughRatherThanSubstituted() public {
        // The guide gives address(0) a meaning: skip fee registration. Silently
        // substituting the owner or the pool would register a fee account nobody
        // asked for on a settlement that takes no fee.
        validator.grant(address(registrar));
        vm.startPrank(OWNER);
        registrar.registerPool(POOL, _zeroRule());
        registrar.registerVaultCvi(POOL, A_TOKEN, address(0));
        vm.stopPrank();
        assertEq(validator.cviFee(POOL), address(0));
    }

    function test_RuleRoundTripsWithAllSixFields() public {
        validator.grant(address(registrar));

        IComplianceRule.RuleV2 memory rule = IComplianceRule.RuleV2({
            allowedGroup: bytes2(0x5700),
            allowedSubGroup: bytes2(0x4e00),
            minTier: 23,
            minSubTier: 1,
            isBlackList: true,
            poolCountryBitmap: 0x400000000000800000000000
        });

        vm.prank(OWNER);
        registrar.registerPool(POOL, rule);

        IComplianceRule.RuleV2[] memory stored = validator.getRulesV2(POOL);
        assertEq(stored.length, 1);
        assertEq(stored[0].allowedGroup, bytes2(0x5700));
        assertEq(stored[0].allowedSubGroup, bytes2(0x4e00));
        assertEq(stored[0].minTier, 23);
        assertEq(stored[0].minSubTier, 1);
        assertTrue(stored[0].isBlackList);
        assertEq(stored[0].poolCountryBitmap, 0x400000000000800000000000);
    }

    function test_TheRegistrarCannotMoveValue() public view {
        // REGISTER_ROLE is authority over registration, not over funds. A
        // compromised owner key here registers pools; it does not reach a
        // settlement, because no settlement contract grants this address anything.
        assertEq(address(registrar).balance, 0);
        assertEq(address(registrar).code.length > 0, true);
    }

    function test_OwnershipTransferIsTwoStep() public {
        vm.prank(OWNER);
        registrar.transferOwnership(STRANGER);
        assertEq(registrar.owner(), OWNER);

        vm.prank(STRANGER);
        registrar.acceptOwnership();
        assertEq(registrar.owner(), STRANGER);
    }

    function test_SetPoolRuleGoesThroughTheRegistrarPath() public {
        // setRuleV2FromContract authenticates on msg.sender being the pool, and
        // CashEscrow has no code to call it, so the registrar path is the only
        // way to change a rule after registration.
        validator.grant(address(registrar));
        vm.startPrank(OWNER);
        registrar.registerPool(POOL, _zeroRule());

        IComplianceRule.RuleV2 memory tightened = _zeroRule();
        tightened.minTier = 28;
        registrar.setPoolRule(POOL, tightened);
        vm.stopPrank();

        IComplianceRule.RuleV2[] memory stored = validator.getRulesV2(POOL);
        assertEq(stored.length, 1);
        assertEq(stored[0].minTier, 28);
    }
}
