// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {AuthorityRegistry} from "../../src/AuthorityRegistry.sol";
import {CashEscrow} from "../../src/CashEscrow.sol";
import {ComplianceAuthority} from "../../src/ComplianceAuthority.sol";
import {ConduitRWACVA} from "../../src/ConduitRWACVA.sol";
import {DispositionController} from "../../src/DispositionController.sol";
import {RWACVASettlementAdapter} from "../../src/RWACVASettlementAdapter.sol";
import {SettlementCoordinator} from "../../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../../src/WormholeTransport.sol";
import {IDispositionExecutor} from "../../src/interfaces/IDispositionExecutor.sol";
import {IWormhole} from "../../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../../src/libraries/ComplianceAttestationLib.sol";
import {DispositionOrderLib} from "../../src/libraries/DispositionOrderLib.sol";
import {DISPOSITION_TYPE_COUNT, DispositionTypes} from "../../src/libraries/DispositionTypes.sol";
import {MessageCodec} from "../../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../../src/libraries/SettlementIntentLib.sol";
import {MockATokenPolicy} from "../mocks/MockATokenPolicy.sol";
import {MockWormhole} from "../mocks/MockWormhole.sol";
import {MockAToken} from "../mocks/TestTokens.sol";
import {ComplianceFixture} from "./ComplianceFixture.sol";

/// @notice The whole stack on two chains, driven to a genuinely held settlement.
///
/// The Disposition Kernel only ever acts on held value, and held value is not a
/// state a test can assert into existence. It is what is left when a canonical
/// COMMIT exists, the cash has moved, and the policy refuses the asset receiver.
/// So this fixture reaches it the way production does — reserve, prepare,
/// commit, attempt delivery, be refused — and every protocol message crossing
/// between the chains is the exact payload a production contract emitted, per
/// ADR-0015.
///
/// Both legs are stood up because the two executors hold value in completely
/// different ways and a kernel proven against one proves nothing about the
/// other. `CashEscrow` custodies an ERC-20 balance; `RWACVASettlementAdapter`
/// custodies nothing at all and works through a token-native reservation. Every
/// order type is exercised against both.
abstract contract DispositionFixture is ComplianceFixture {
    // ── The two chains ───────────────────────────────────────────────────────

    uint256 internal constant MONAD = 10_143;
    uint256 internal constant BASE = 84_532;
    uint16 internal constant MONAD_WH = 10_009;
    uint16 internal constant BASE_WH = 10_004;

    bytes32 internal constant DEPLOYMENT_ID = keccak256("conduit-disposition-kernel");
    bytes32 internal constant POLICY_ID = keccak256("conduit-disposition-policy-v1");

    /// @dev Long enough that a test has to warp deliberately to execute, which
    ///      is the property the contest window exists for.
    uint32 internal constant CONTEST_WINDOW = 30 minutes;
    uint64 internal constant GRANT_DELAY = 1 days;

    MockWormhole internal monadCore;
    MockWormhole internal baseCore;

    SettlementCoordinator internal coordinator;
    CashEscrow internal escrow;
    MockAToken internal cash;
    AuthorityRegistry internal monadRegistry;
    DispositionController internal monadKernel;

    ConduitRWACVA internal rwa;
    RWACVASettlementAdapter internal adapter;
    MockATokenPolicy internal policy;
    AuthorityRegistry internal baseRegistry;
    DispositionController internal baseKernel;

    uint256 internal constant BUYER_KEY = 0xB0FFEE;
    uint256 internal constant SELLER_KEY = 0x5E11E4;
    address internal buyer;
    address internal seller;

    // ── The authorities, one per PRD FR-012 class that the tests need ────────

    uint256 internal constant ISSUER_KEY = 0x155DE4;
    uint256 internal constant AGENT_KEY = 0xA6E47;
    uint256 internal constant OPERATOR_KEY = 0x09E4A704;
    uint256 internal constant GATEWAY_KEY = 0x6A7E3A7;
    uint256 internal constant SUBJECT_KEY = BUYER_KEY;
    uint256 internal constant STRANGER_KEY = 0x57A46E4;

    address internal issuer;
    address internal agent;
    address internal operator;
    address internal gateway;
    address internal stranger;

    /// @dev Destinations. Each is permissible for exactly one order type, which
    ///      is the registry's whole design and is worth being able to state in a
    ///      test by name.
    address internal rebindWallet = address(0x8EB14D);
    address internal substituteWallet = address(0x5085);
    address internal custodyAccount = address(0xC057);
    address internal gatewayAccount = address(0x6A7E);

    address internal constant OWNER = address(0x0E7E4);
    address internal constant RELAYER = address(0x4E1A4);
    address internal constant OTHER_RELAYER = address(0x4E1A5);

    uint256 internal constant CASH_AMOUNT = 25_000e6;
    uint256 internal constant ASSET_AMOUNT = 500e3;
    uint256 internal constant ASSET_SUPPLY = 2000e3;

    bytes32 internal coordinatorDomain;
    bytes32 internal escrowDomain;
    bytes32 internal adapterDomain;

    uint64 internal prepareDeadline;
    uint64 internal commitDeadline;
    uint64 internal releaseDeadline;

    /// @dev Nonces are consumed per authority for the life of a controller, so a
    ///      counter beats hand-picked numbers: two tests reusing 1 would pass
    ///      individually and interact in a suite that shares state.
    uint256 private _nextNonce = 1;

    function setUp() public virtual {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        issuer = vm.addr(ISSUER_KEY);
        agent = vm.addr(AGENT_KEY);
        operator = vm.addr(OPERATOR_KEY);
        gateway = vm.addr(GATEWAY_KEY);
        stranger = vm.addr(STRANGER_KEY);

        prepareDeadline = uint64(block.timestamp + 1 hours);
        commitDeadline = uint64(block.timestamp + 2 hours);
        releaseDeadline = uint64(block.timestamp + 3 hours);

        _deployMonad();
        _deployBase();
        _closeThePeerLoop();
        _seedAuthorities();
    }

    // ── Deployment ───────────────────────────────────────────────────────────

    function _deployMonad() private {
        vm.chainId(MONAD);
        monadCore = new MockWormhole(MONAD_WH);
        cash = new MockAToken(6);

        coordinator = new SettlementCoordinator(
            address(monadCore),
            DEPLOYMENT_ID,
            MONAD_WH,
            BASE_WH,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER,
            "Conduit",
            "1"
        );
        escrow = new CashEscrow(
            address(cash),
            address(coordinator),
            address(monadCore),
            DEPLOYMENT_ID,
            MONAD_WH,
            BASE_WH,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER
        );
        monadRegistry = new AuthorityRegistry(OWNER, GRANT_DELAY);
        monadKernel =
            new DispositionController(address(monadRegistry), DEPLOYMENT_ID, OWNER, "Conduit", "1");
    }

    function _deployBase() private {
        vm.chainId(BASE);
        baseCore = new MockWormhole(BASE_WH);
        policy = new MockATokenPolicy();
        rwa = new ConduitRWACVA("Conduit Bond", "cBOND", 6, address(policy), OWNER);
        adapter = new RWACVASettlementAdapter(
            address(rwa),
            address(baseCore),
            DEPLOYMENT_ID,
            BASE_WH,
            MONAD_WH,
            _emitter(address(coordinator)),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER
        );
        baseRegistry = new AuthorityRegistry(OWNER, GRANT_DELAY);
        baseKernel =
            new DispositionController(address(baseRegistry), DEPLOYMENT_ID, OWNER, "Conduit", "1");

        adapterDomain = adapter.attestationDomainSeparator();

        vm.startPrank(OWNER);
        rwa.grantRole(rwa.MINTER_ROLE(), OWNER);
        rwa.grantRole(rwa.SETTLEMENT_ROLE(), address(adapter));
        rwa.mint(seller, ASSET_SUPPLY);
        adapter.addComplianceSigner(_signerA());
        adapter.setComplianceQuorum(1);
        adapter.setDispositionController(address(baseKernel));
        baseKernel.setExecutor(DispositionTypes.Leg.ASSET, address(adapter));
        vm.stopPrank();
    }

    function _closeThePeerLoop() private {
        vm.chainId(MONAD);
        coordinatorDomain = coordinator.attestationDomainSeparator();
        escrowDomain = escrow.attestationDomainSeparator();

        vm.startPrank(OWNER);
        coordinator.setRemotePeer(_emitter(address(adapter)));
        escrow.setRemotePeer(_emitter(address(adapter)));
        coordinator.setCashEscrow(address(escrow));
        coordinator.addComplianceSigner(_signerA());
        coordinator.setComplianceQuorum(1);
        escrow.addComplianceSigner(_signerA());
        escrow.setComplianceQuorum(1);
        escrow.setDispositionController(address(monadKernel));
        monadKernel.setExecutor(DispositionTypes.Leg.CASH, address(escrow));
        vm.stopPrank();

        cash.mint(buyer, CASH_AMOUNT * 4);
        vm.prank(buyer);
        cash.approve(address(escrow), type(uint256).max);
    }

    /// @dev Every grant waits out `GRANT_DELAY`, then the clock is put back so
    ///      the settlement deadlines a test relies on are still open. A fixture
    ///      that skipped the delay would be testing a registry that does not
    ///      exist.
    function _seedAuthorities() private {
        uint256 startedAt = block.timestamp;

        for (uint256 i = 0; i < 2; i += 1) {
            AuthorityRegistry registry = i == 0 ? monadRegistry : baseRegistry;
            vm.chainId(i == 0 ? MONAD : BASE);

            vm.startPrank(OWNER);
            registry.proposeAuthority(issuer, DispositionTypes.AuthorityType.ISSUER);
            registry.proposeAuthority(agent, DispositionTypes.AuthorityType.TRANSFER_AGENT);
            registry.proposeAuthority(operator, DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR);
            registry.proposeAuthority(gateway, DispositionTypes.AuthorityType.GATEWAY_OPERATOR);
            registry.proposeAuthority(buyer, DispositionTypes.AuthorityType.SUBJECT);
            registry.setPolicy(POLICY_ID, _policy());
            vm.stopPrank();

            vm.warp(startedAt + GRANT_DELAY + 1);
            registry.activateAuthority(issuer);
            registry.activateAuthority(agent);
            registry.activateAuthority(operator);
            registry.activateAuthority(gateway);
            registry.activateAuthority(buyer);

            // The destinations, each on the list its own order type reads.
            vm.startPrank(OWNER);
            registry.setIdentityCommitment(buyer, _identityOf(buyer));
            registry.setIdentityCommitment(rebindWallet, _identityOf(buyer));
            registry.setIdentityCommitment(seller, _identityOf(seller));
            registry.proposeSubstitute(buyer, substituteWallet);
            registry.proposeSubstitute(seller, substituteWallet);
            registry.proposeRestrictedCustodian(custodyAccount);
            registry.proposeGatewayAccount(gatewayAccount);
            vm.stopPrank();

            vm.warp(startedAt + 2 * GRANT_DELAY + 2);
            registry.activateSubstitute(buyer, substituteWallet);
            registry.activateSubstitute(seller, substituteWallet);
            registry.activateRestrictedCustodian(custodyAccount);
            registry.activateGatewayAccount(gatewayAccount);

            vm.warp(startedAt);
        }
        vm.chainId(MONAD);
    }

    /// @dev The same legal identity behind two wallets is what a rebind asserts.
    ///      A commitment rather than a name, because PRD forbids raw PII on
    ///      chain.
    function _identityOf(address person) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("identity-commitment", person));
    }

    function _policy() internal pure returns (AuthorityRegistry.AuthorityPolicy memory) {
        uint8[DISPOSITION_TYPE_COUNT] memory required;
        required[uint8(DispositionTypes.DispositionType.REVERIFY_AND_RESUME)] = 1;
        // Two, because a rebind sends committed value to a wallet the
        // counterparties never named. PRD 5.4 puts an operator process behind
        // it, and one signature is not a process.
        required[uint8(DispositionTypes.DispositionType.REBIND_RECEIVER)] = 2;
        required[uint8(DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER)] = 1;
        required[uint8(DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION)] = 1;
        required[uint8(DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP)] = 1;
        required[uint8(DispositionTypes.DispositionType.RESTRICTED_HOLD)] = 1;

        uint16 signers = DispositionTypes.authorityBit(DispositionTypes.AuthorityType.ISSUER)
            | DispositionTypes.authorityBit(DispositionTypes.AuthorityType.TRANSFER_AGENT)
            | DispositionTypes.authorityBit(DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR)
            | DispositionTypes.authorityBit(DispositionTypes.AuthorityType.GATEWAY_OPERATOR)
            | DispositionTypes.authorityBit(DispositionTypes.AuthorityType.SUBJECT);

        // The transfer agent adjudicates. Deliberately narrower than the set
        // that may sign orders, so the classes that can create a conflict are
        // not automatically the ones that resolve it.
        uint16 resolvers =
            DispositionTypes.authorityBit(DispositionTypes.AuthorityType.TRANSFER_AGENT);

        return AuthorityRegistry.AuthorityPolicy({
            active: true,
            contestWindow: CONTEST_WINDOW,
            allowedAuthorityTypes: signers,
            resolverAuthorityTypes: resolvers,
            resolverSignatures: 1,
            requiredSignatures: required
        });
    }

    // ── Transport plumbing, and nothing more ─────────────────────────────────

    function _emitter(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _relay(MockWormhole core, uint16 emitterChain, address emitterAddress, uint256 index)
        private
        view
        returns (bytes memory)
    {
        MockWormhole.Published memory published = core.publishedAt(index);
        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: published.nonce,
            emitterChainId: emitterChain,
            emitterAddress: _emitter(emitterAddress),
            // casting to 'uint64' is safe because the index is a position in a
            // test's own publication log, bounded by the messages it sent
            // forge-lint: disable-next-line(unsafe-typecast)
            sequence: uint64(index),
            consistencyLevel: published.consistencyLevel,
            payload: published.payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: keccak256(abi.encodePacked(emitterAddress, index, published.payload))
        });
        return abi.encode(vaa);
    }

    function _fromBase(uint256 index) internal view returns (bytes memory) {
        return _relay(baseCore, BASE_WH, address(adapter), index);
    }

    function _fromMonad(uint256 index) internal view returns (bytes memory) {
        return _relay(monadCore, MONAD_WH, address(coordinator), index);
    }

    // ── The intent both chains agree on ──────────────────────────────────────

    function _intent() internal view returns (SettlementIntentLib.SettlementIntent memory) {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: MONAD,
            cashEscrow: address(escrow),
            cashAsset: address(cash),
            cashAmount: CASH_AMOUNT,
            cashPayer: buyer,
            cashReceiver: seller,
            assetChainId: BASE,
            assetEscrow: address(rwa),
            assetToken: address(rwa),
            assetAmount: ASSET_AMOUNT,
            assetSeller: seller,
            assetReceiver: buyer,
            cashPolicyHash: keccak256("cash-policy"),
            assetPolicyHash: keccak256("asset-policy"),
            prepareDeadline: prepareDeadline,
            commitDeadline: commitDeadline,
            releaseDeadline: releaseDeadline,
            nonce: 7
        });
    }

    function _settlementId() internal view returns (bytes32) {
        return SettlementIntentLib.digest(_intent(), coordinator.domainSeparator());
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _proof(bytes32 domain, bytes32 settlementId, address subject, bool eligible)
        internal
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            domain, _keys(SIGNER_A_KEY), settlementId, settlementId, _subjects(subject), eligible
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    function _commitProof(bytes32 settlementId)
        internal
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            coordinatorDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(buyer, seller),
            true
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    // ── Reaching a genuinely held settlement ─────────────────────────────────

    /// @dev Both legs prepared, COMMIT issued, COMMIT delivered to Base, and
    ///      both legs refused on delivery. What remains is exactly what the
    ///      kernel is for: value a canonical decision has spoken for, that
    ///      cannot reach the party the intent named, and that no refund can
    ///      reclaim.
    function _holdBothLegs() internal returns (bytes32 settlementId) {
        settlementId = _settlementId();

        vm.chainId(BASE);
        uint256 preparedIndex = baseCore.publishedCount();
        vm.startPrank(seller);
        rwa.reserveForSettlement(settlementId, ASSET_AMOUNT);
        adapter.prepareAsset(settlementId, settlementId, buyer, MONAD, 1);
        vm.stopPrank();

        vm.chainId(MONAD);
        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, seller, CASH_AMOUNT, BASE, 1);

        vm.prank(RELAYER);
        coordinator.recordAssetPrepared(_fromBase(preparedIndex));

        uint256 commitIndex = monadCore.publishedCount();
        vm.prank(RELAYER);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            _commitProof(settlementId),
            1
        );

        // The cash receiver is refused, so the cash is held rather than paid.
        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, false));

        // And on Base the asset receiver is refused too.
        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );

        // The asset leg reports its hold, and the coordinator records it. Left
        // out, the canonical state would read COMMIT_ISSUED while both legs were
        // stuck — which is what the coordinator genuinely knows if nobody
        // relays, and not the state a disposition is supposed to act from.
        _reportAssetHeld(settlementId);
        vm.chainId(MONAD);
    }

    /// @dev The adapter publishes ASSET_HELD and a relayer carries it home, so
    ///      the coordinator reaches PRD 7.1's HELD before any disposition runs.
    function _reportAssetHeld(bytes32 settlementId) internal {
        vm.chainId(BASE);
        uint256 index = baseCore.publishedCount();
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        vm.chainId(MONAD);
        bytes memory report = _fromBase(index);
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            report, MessageCodec.MessageType.ASSET_HELD, SettlementCoordinator.LegOutcome.HELD
        );
    }

    /// @dev Only the asset leg held: the cash reaches the seller normally. The
    ///      shape the live generation-2 run produced, and the one that proves a
    ///      disposition can complete a settlement that is half delivered.
    function _holdAssetLegOnly() internal returns (bytes32 settlementId, uint256 commitIndex) {
        settlementId = _settlementId();

        vm.chainId(BASE);
        uint256 preparedIndex = baseCore.publishedCount();
        vm.startPrank(seller);
        rwa.reserveForSettlement(settlementId, ASSET_AMOUNT);
        adapter.prepareAsset(settlementId, settlementId, buyer, MONAD, 1);
        vm.stopPrank();

        vm.chainId(MONAD);
        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, seller, CASH_AMOUNT, BASE, 1);
        vm.prank(RELAYER);
        coordinator.recordAssetPrepared(_fromBase(preparedIndex));

        commitIndex = monadCore.publishedCount();
        vm.prank(RELAYER);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            _commitProof(settlementId),
            1
        );

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, true));

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );
        _reportAssetHeld(settlementId);
        vm.chainId(MONAD);
    }

    // ── Building and signing orders ──────────────────────────────────────────

    function _nonce() internal returns (uint256) {
        return _nextNonce++;
    }

    /// @dev Filled from the held leg the executor reports, not from the test's
    ///      idea of it. An order built from a test's own beliefs would pass the
    ///      controller's binding checks for the wrong reason, which is exactly
    ///      the ADR-0015 failure mode on the order side.
    function _order(
        DispositionController kernel,
        AuthorityRegistry registry,
        DispositionTypes.Leg leg,
        DispositionTypes.DispositionType dispositionType,
        address destination,
        address authority,
        DispositionTypes.AuthorityType authorityType
    ) internal returns (DispositionOrderLib.DispositionOrder memory order) {
        bytes32 settlementId = _settlementId();
        address executor = address(kernel.executorFor(leg));
        (IDispositionExecutor.HeldLeg memory held, uint64 version) =
            _heldLeg(kernel, leg, settlementId);

        order = DispositionOrderLib.DispositionOrder({
            caseId: DispositionOrderLib.caseIdFor(DEPLOYMENT_ID, settlementId, leg),
            settlementId: settlementId,
            deploymentId: DEPLOYMENT_ID,
            leg: leg,
            dispositionType: dispositionType,
            sourceEscrow: executor,
            asset: held.asset,
            amount: held.amount,
            currentReceiver: held.currentReceiver,
            destination: destination,
            destinationIdentityCommitment: registry.identityCommitmentOf(destination),
            authority: authority,
            authorityType: authorityType,
            authorityPolicyId: POLICY_ID,
            authorityPolicyHash: registry.policyHash(POLICY_ID),
            evidenceCommitment: keccak256(abi.encodePacked("case-file", destination)),
            complianceAttestationIds: keccak256(abi.encodePacked("attestation-set", destination)),
            notBefore: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 7 days),
            nonce: _nonce(),
            hostStateVersion: version
        });
    }

    function _heldLeg(DispositionController kernel, DispositionTypes.Leg leg, bytes32 settlementId)
        internal
        view
        returns (IDispositionExecutor.HeldLeg memory heldLeg, uint64 version)
    {
        IDispositionExecutor executor = kernel.executorFor(leg);
        return (executor.heldLegOf(settlementId), executor.hostStateVersion(settlementId));
    }

    function _fileOrder(
        DispositionController kernel,
        DispositionOrderLib.DispositionOrder memory order,
        uint256 authorityKey
    ) internal returns (bytes32 orderHash) {
        bytes32 digest = kernel.orderDigest(order);
        vm.prank(RELAYER);
        orderHash = kernel.fileOrder(order, _sign(authorityKey, digest));
    }

    function _resolution(
        AuthorityRegistry registry,
        bytes32 caseId,
        bytes32 winner,
        address authority,
        DispositionTypes.AuthorityType authorityType
    ) internal returns (DispositionOrderLib.ConflictResolution memory) {
        return DispositionOrderLib.ConflictResolution({
            caseId: caseId,
            deploymentId: DEPLOYMENT_ID,
            winningOrderHash: winner,
            authority: authority,
            authorityType: authorityType,
            authorityPolicyId: POLICY_ID,
            authorityPolicyHash: registry.policyHash(POLICY_ID),
            evidenceCommitment: keccak256("adjudication-file"),
            notBefore: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 7 days),
            nonce: _nonce()
        });
    }
}
