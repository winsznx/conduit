// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {DispositionOrderLib} from "../src/libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "../src/libraries/DispositionTypes.sol";

/// @notice Fixed vectors, asserted identically in TypeScript.
///
/// `packages/domain/src/disposition.test.ts` builds the same order from the same
/// values and asserts the same three digests. The two implementations are
/// written independently — one hashes by hand in three `abi.encode` chunks
/// because twenty-two words exceed the stack, the other hands a typed structure
/// to viem — and neither can catch the other's field-order mistake by
/// construction.
///
/// A reordering is not a compile error in either language. It is a signature an
/// authority produces for one set of terms and a controller accepts as another,
/// which is why the check is a pinned constant rather than a round trip.
contract DispositionOrderLibTest is Test {
    bytes32 private constant DEPLOYMENT_ID =
        0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417;
    bytes32 private constant SETTLEMENT_ID =
        0x30aa1b738cab5f534452b7ef4515119232505dba674ab768520e58be59ef4a17;

    /// @dev The live generation-2 adapter on Base, so a vector in a report is
    ///      recognisable rather than arbitrary.
    address private constant VERIFYING_CONTRACT = 0x51c3D536e94fB5b944c2AF8946d6916543bdf93a;
    uint256 private constant BASE_SEPOLIA = 84_532;

    bytes32 private constant EXPECTED_CASE_ID =
        0xc5ccafeff84d3789d9ae40a849ba1ad6a65e21362c4245f076cb470a77b17406;
    bytes32 private constant EXPECTED_ORDER_DIGEST =
        0xe1352b3dd7430527001053f018f6a9e5adbb70c88f9e3dc73e96b45e52b42acc;
    bytes32 private constant EXPECTED_RESOLUTION_DIGEST =
        0xf08fc7ff902a0d4b15ea663e1b3c02ddb42cac7ca7876f8687116656103b0140;

    function _domain() private pure returns (bytes32) {
        return DispositionOrderLib.domainSeparator("Conduit", "1", BASE_SEPOLIA, VERIFYING_CONTRACT);
    }

    function _order() private pure returns (DispositionOrderLib.DispositionOrder memory) {
        return DispositionOrderLib.DispositionOrder({
            caseId: DispositionOrderLib.caseIdFor(
                DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.ASSET
            ),
            settlementId: SETTLEMENT_ID,
            deploymentId: DEPLOYMENT_ID,
            leg: DispositionTypes.Leg.ASSET,
            dispositionType: DispositionTypes.DispositionType.REBIND_RECEIVER,
            sourceEscrow: VERIFYING_CONTRACT,
            asset: 0x7a78912533b43C483621200b4919806c0B855E5b,
            amount: 500_000,
            currentReceiver: 0x00000000000000000000000000000000000000B1,
            destination: 0x00000000000000000000000000000000000000b2,
            destinationIdentityCommitment: keccak256("identity-commitment"),
            authority: 0x00000000000000000000000000000000000000a6,
            authorityType: DispositionTypes.AuthorityType.TRANSFER_AGENT,
            authorityPolicyId: keccak256("conduit-disposition-policy-v1"),
            authorityPolicyHash: keccak256("policy-content"),
            evidenceCommitment: keccak256("case-file"),
            complianceAttestationIds: keccak256("attestation-set"),
            notBefore: 1_754_600_000,
            expiry: 1_755_204_800,
            nonce: 42,
            hostStateVersion: 3
        });
    }

    function _resolution() private pure returns (DispositionOrderLib.ConflictResolution memory) {
        return DispositionOrderLib.ConflictResolution({
            caseId: DispositionOrderLib.caseIdFor(
                DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.ASSET
            ),
            deploymentId: DEPLOYMENT_ID,
            winningOrderHash: keccak256("the winning order"),
            authority: 0x00000000000000000000000000000000000000a6,
            authorityType: DispositionTypes.AuthorityType.TRANSFER_AGENT,
            authorityPolicyId: keccak256("conduit-disposition-policy-v1"),
            authorityPolicyHash: keccak256("policy-content"),
            evidenceCommitment: keccak256("adjudication-file"),
            notBefore: 1_754_600_000,
            expiry: 1_755_204_800,
            nonce: 43
        });
    }

    function test_TheCaseIdMatchesTheTypeScriptVector() public pure {
        assertEq(
            DispositionOrderLib.caseIdFor(DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.ASSET),
            EXPECTED_CASE_ID
        );
    }

    function test_TheOrderDigestMatchesTheTypeScriptVector() public pure {
        assertEq(DispositionOrderLib.digest(_domain(), _order()), EXPECTED_ORDER_DIGEST);
    }

    function test_TheResolutionDigestMatchesTheTypeScriptVector() public pure {
        assertEq(DispositionOrderLib.digest(_domain(), _resolution()), EXPECTED_RESOLUTION_DIGEST);
    }

    /// @dev The three-chunk `bytes.concat` in `hashStruct` exists only because
    ///      twenty-two words exceed the stack. If the split changed the digest it
    ///      would not be a split, it would be a different hash, so the equality
    ///      with the single-encoding form is asserted rather than assumed.
    function test_TheChunkedEncodingEqualsASingleEncoding() public pure {
        DispositionOrderLib.DispositionOrder memory order = _order();
        bytes32 single = keccak256(
            bytes.concat(
                abi.encode(
                    DispositionOrderLib.DISPOSITION_ORDER_TYPEHASH,
                    order.caseId,
                    order.settlementId,
                    order.deploymentId,
                    uint8(order.leg),
                    uint8(order.dispositionType),
                    order.sourceEscrow,
                    order.asset,
                    order.amount,
                    order.currentReceiver,
                    order.destination,
                    order.destinationIdentityCommitment
                ),
                abi.encode(
                    order.authority,
                    uint8(order.authorityType),
                    order.authorityPolicyId,
                    order.authorityPolicyHash,
                    order.evidenceCommitment,
                    order.complianceAttestationIds,
                    order.notBefore,
                    order.expiry,
                    order.nonce,
                    order.hostStateVersion
                )
            )
        );
        assertEq(DispositionOrderLib.hashStruct(order), single);
    }

    function test_TheTwoLegsOfOneSettlementGetDifferentCases() public pure {
        assertTrue(
            DispositionOrderLib.caseIdFor(DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.CASH)
                != DispositionOrderLib.caseIdFor(
                    DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.ASSET
                )
        );
    }

    /// @dev Two live generations hold real settlements against the same token,
    ///      and they have already collided on an address once (ADR-0018). A case
    ///      is keyed by generation for the same reason a contract is.
    function test_TwoGenerationsGetDifferentCasesForOneSettlement() public pure {
        bytes32 older = 0x9303f240f88e5aba93761e010b75b13681d0c03af58d945c241cc402dadd0843;
        assertTrue(
            DispositionOrderLib.caseIdFor(older, SETTLEMENT_ID, DispositionTypes.Leg.ASSET)
                != DispositionOrderLib.caseIdFor(
                    DEPLOYMENT_ID, SETTLEMENT_ID, DispositionTypes.Leg.ASSET
                )
        );
    }

    function test_TheDigestIsBoundToTheChainAndTheController() public pure {
        DispositionOrderLib.DispositionOrder memory order = _order();
        bytes32 onMonad = DispositionOrderLib.digest(
            DispositionOrderLib.domainSeparator("Conduit", "1", 10_143, VERIFYING_CONTRACT), order
        );
        bytes32 otherContract = DispositionOrderLib.digest(
            DispositionOrderLib.domainSeparator(
                "Conduit", "1", BASE_SEPOLIA, 0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86
            ),
            order
        );
        assertTrue(onMonad != EXPECTED_ORDER_DIGEST);
        assertTrue(otherContract != EXPECTED_ORDER_DIGEST);
    }

    /// @dev The enum values are written into signed orders and into the
    ///      registry's permission bitmasks. Renumbering one turns a
    ///      RESTRICTED_HOLD permission into a REBIND_RECEIVER permission on any
    ///      contract not redeployed alongside it.
    function test_TheEnumsAreNumberedTheWayThePrdListsThem() public pure {
        assertEq(uint8(DispositionTypes.DispositionType.REVERIFY_AND_RESUME), 0);
        assertEq(uint8(DispositionTypes.DispositionType.REBIND_RECEIVER), 1);
        assertEq(uint8(DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER), 2);
        assertEq(uint8(DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION), 3);
        assertEq(uint8(DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP), 4);
        assertEq(uint8(DispositionTypes.DispositionType.RESTRICTED_HOLD), 5);

        assertEq(uint8(DispositionTypes.AuthorityType.SUBJECT), 0);
        assertEq(uint8(DispositionTypes.AuthorityType.COUNTERPARTY), 1);
        assertEq(uint8(DispositionTypes.AuthorityType.ISSUER), 2);
        assertEq(uint8(DispositionTypes.AuthorityType.TRANSFER_AGENT), 3);
        assertEq(uint8(DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR), 4);
        assertEq(uint8(DispositionTypes.AuthorityType.GATEWAY_OPERATOR), 5);
        assertEq(uint8(DispositionTypes.AuthorityType.MULTISIG), 6);
    }

    /// @dev A bitmask over seven classes. Each bit has to be its own, and the
    ///      widest value must still fit in the `uint16` the policy stores.
    function test_EveryAuthorityClassGetsItsOwnBit() public pure {
        uint16 all = 0;
        for (uint8 i = 0; i <= uint8(DispositionTypes.AuthorityType.MULTISIG); i += 1) {
            uint16 bit = DispositionTypes.authorityBit(DispositionTypes.AuthorityType(i));
            assertEq(all & bit, 0, "bits must not overlap");
            all |= bit;
            assertTrue(DispositionTypes.permits(all, DispositionTypes.AuthorityType(i)));
        }
        assertEq(all, 127);
    }
}
