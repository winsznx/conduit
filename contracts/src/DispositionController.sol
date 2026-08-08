// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {AuthorityRegistry} from "./AuthorityRegistry.sol";
import {ComplianceAuthority} from "./ComplianceAuthority.sol";
import {IDispositionExecutor} from "./interfaces/IDispositionExecutor.sol";
import {DispositionOrderLib} from "./libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "./libraries/DispositionTypes.sol";

/// @notice The Disposition Kernel. PRD 8.1, FR-012, journeys 5.3 to 5.5.
///
/// Held value is value that a canonical decision has already spoken for and
/// that cannot be delivered. There is no refund, because a COMMIT exists. There
/// is no delivery, because the policy refuses the recipient. Invariant I9 says
/// held value remains claimable only through this contract, and everything below
/// is what "only" has to mean for that to be a safety property rather than a
/// slogan.
///
/// ## Why an order rests before it executes
///
/// PRD FR-012's last line says conflicting valid orders produce `CONTESTED` and
/// no funds move until the conflict is resolved under the policy. Taken
/// literally against an immediate-execution design, that line is unenforceable:
/// if the first valid order executes on arrival, a second conflicting order
/// arrives to find a settled case, and the outcome was decided by whichever
/// relayer's transaction landed first. Two authorities genuinely disagreeing
/// would be adjudicated by gas price.
///
/// So a filed order rests for the policy's `contestWindow` before it may be
/// executed, and anyone may file during that window. Filing something
/// incompatible with the resting order contests the case, and a contested case
/// executes nothing until an authority the policy names as a resolver picks a
/// winner. This is the only structure that makes the PRD's sentence true, and it
/// is what `test_ARelayerRaceCannotDecideTheOutcome` demonstrates.
///
/// ## What "compatible" means
///
/// Four things decide where value ends up: the order type, the destination, the
/// amount and the asset. Two orders agreeing on all four have the same effect
/// whichever executes, so the second is a co-signature rather than a conflict —
/// which is also how a policy requiring two signatures is satisfied. Disagreeing
/// on any of them is a conflict, including two orders of the same type pointing
/// at different destinations.
///
/// ## What this contract cannot do
///
/// It holds no value, has no token reference, and cannot construct an order.
/// Its owner can point it at an executor once per leg and nothing else. Every
/// path to value requires a typed signature from a registered authority, a
/// policy that permits that authority to sign that type, a destination the
/// registry permits for that type, an amount equal to the held amount, a case
/// that is not contested, a rested order, and fresh compliance checked by the
/// executor at the moment of transfer.
contract DispositionController is Ownable2Step, ReentrancyGuard {
    using DispositionOrderLib for DispositionOrderLib.DispositionOrder;
    using DispositionOrderLib for DispositionOrderLib.ConflictResolution;
    using DispositionTypes for uint16;

    /// @notice A case's position in PRD FR-012's lifecycle.
    ///
    /// @dev These are the kernel's own states and are not PRD 7.1's settlement
    ///      states. A case being `CONTESTED` is what drives the settlement to
    ///      the `CONTESTED` state, but the two enums answer different questions
    ///      and are deliberately not shared.
    enum CaseState {
        NONE,
        /// @dev At least one valid order is filed and they all agree.
        OPEN,
        /// @dev Two valid orders disagree. Nothing executes.
        CONTESTED,
        /// @dev A resolver picked a winner. Executable without a further wait.
        ADJUDICATED,
        /// @dev Terminal. The value has moved.
        EXECUTED
    }

    /// @dev The four fields that decide where value ends up, hashed. Two orders
    ///      sharing this key are the same instruction from different authorities.
    struct Terms {
        DispositionTypes.DispositionType dispositionType;
        address destination;
        uint256 amount;
        address asset;
    }

    /// @notice Everything an independent verifier needs, in state rather than
    ///         in events.
    ///
    /// @dev PRD 15.2's verifier reads two chains and a guardian set and consults
    ///      no application database. Reconstructing a disposition from event
    ///      logs would make it dependent on a log range it can scan, and public
    ///      endpoints cap those at a hundred blocks on Monad — the same
    ///      constraint that once had the settlement verifier certify a terminal
    ///      state having read one message of three. So the case carries the
    ///      answer: which order won, who signed it, under which policy content,
    ///      where the value went, and against which compliance proof.
    struct Case {
        CaseState state;
        DispositionTypes.Leg leg;
        bytes32 settlementId;
        bytes32 policyId;
        /// @dev The policy *content* every order in this case bound, captured at
        ///      the first filing. The registry's current hash may have moved
        ///      since; what authorized this case is this value.
        bytes32 policyHash;
        bytes32 leadTermsKey;
        bytes32 leadOrderHash;
        uint64 filedAt;
        uint8 signatures;
        bytes32 executedOrderHash;
        DispositionTypes.DispositionType executedType;
        address executedDestination;
        uint256 executedAmount;
        /// @dev The exact compliance proof the executor checked at the moment of
        ///      transfer, by hash. The preimage lives in the evidence package;
        ///      this is what stops the package being swapped afterwards.
        bytes32 executedComplianceDigest;
    }

    AuthorityRegistry public immutable registry;
    bytes32 public immutable deploymentId;
    bytes32 public immutable domainSeparator;

    mapping(DispositionTypes.Leg leg => IDispositionExecutor) private _executors;

    mapping(bytes32 caseId => Case) private _cases;
    mapping(bytes32 caseId => mapping(bytes32 orderHash => Terms)) private _filedTerms;
    mapping(bytes32 caseId => mapping(bytes32 orderHash => bool)) private _filed;
    mapping(bytes32 caseId => mapping(address authority => bool)) private _hasSigned;
    /// @dev In order of filing, so a report can name who backed the outcome.
    mapping(bytes32 caseId => address[]) private _caseAuthorities;
    mapping(address authority => mapping(uint256 nonce => bool)) private _usedNonces;

    event ExecutorSet(DispositionTypes.Leg indexed leg, address executor);
    event OrderFiled(
        bytes32 indexed caseId,
        bytes32 indexed orderHash,
        address indexed authority,
        DispositionTypes.DispositionType dispositionType,
        address destination,
        uint8 signatures
    );
    event CaseContested(
        bytes32 indexed caseId, bytes32 restingOrderHash, bytes32 conflictingOrderHash
    );
    event CaseAdjudicated(bytes32 indexed caseId, bytes32 winningOrderHash);
    event DispositionExecuted(
        bytes32 indexed caseId,
        bytes32 indexed settlementId,
        bytes32 indexed orderHash,
        DispositionTypes.DispositionType dispositionType,
        address destination,
        uint256 amount
    );

    error ZeroAddress();
    error ExecutorAlreadySet(DispositionTypes.Leg leg);
    error NoExecutorForLeg(DispositionTypes.Leg leg);
    error WrongDeployment(bytes32 provided, bytes32 expected);
    error CaseIdMismatch(bytes32 provided, bytes32 derived);
    error OrderNotYetValid(uint64 notBefore, uint256 nowTimestamp);
    error OrderExpired(uint64 expiry, uint256 nowTimestamp);
    error NonceAlreadyUsed(address authority, uint256 nonce);
    error InvalidAuthoritySignature(address authority);
    error PolicyHashMismatch(bytes32 provided, bytes32 actual);
    error AuthorityTypeNotPermitted(DispositionTypes.AuthorityType authorityType);
    error DispositionTypeNotPermitted(DispositionTypes.DispositionType dispositionType);
    error LegNotHeld(bytes32 settlementId);
    error HostStateVersionMismatch(uint64 provided, uint64 actual);
    error SourceEscrowMismatch(address provided, address expected);
    error AssetMismatch(address provided, address expected);
    error AmountMismatch(uint256 provided, uint256 expected);
    error CurrentReceiverMismatch(address provided, address expected);
    error DestinationNotPermitted(
        DispositionTypes.DispositionType dispositionType, address destination
    );
    error IdentityCommitmentMismatch(bytes32 provided, bytes32 expected);
    error ReturnRequiresCommit(bytes32 settlementId);
    error AuthorityAlreadySigned(address authority);
    error CaseNotOpen(bytes32 caseId, CaseState state);
    error CaseIsTerminal(bytes32 caseId);
    error CaseNotContested(bytes32 caseId, CaseState state);
    error ContestWindowOpen(uint64 openUntil, uint256 nowTimestamp);
    error SignaturesBelowThreshold(uint256 have, uint8 required);
    error OrderNotFiled(bytes32 caseId, bytes32 orderHash);
    error ResolutionsDisagree(bytes32 first, bytes32 other);
    error PolicyMismatchAcrossOrders(bytes32 provided, bytes32 expected);
    error NoResolutionsProvided();

    constructor(
        address registry_,
        bytes32 deploymentId_,
        address owner_,
        string memory domainName,
        string memory domainVersion
    ) Ownable(owner_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = AuthorityRegistry(registry_);
        deploymentId = deploymentId_;
        domainSeparator = DispositionOrderLib.domainSeparator(
            domainName, domainVersion, block.chainid, address(this)
        );
    }

    /// @notice Fixes the executor for one leg. Callable once per leg, forever.
    ///
    /// @dev One controller serves whichever legs live on its chain: the cash leg
    ///      on Monad, the asset leg on Base. Set-once for the reason the peer
    ///      emitter is: the two contracts reference each other, so the first
    ///      deployed cannot know the second, and the window has to close rather
    ///      than stay open for an owner who could otherwise repoint a live case.
    function setExecutor(DispositionTypes.Leg leg, address executor) external onlyOwner {
        if (executor == address(0)) revert ZeroAddress();
        if (address(_executors[leg]) != address(0)) revert ExecutorAlreadySet(leg);
        _executors[leg] = IDispositionExecutor(executor);
        emit ExecutorSet(leg, executor);
    }

    function executorFor(DispositionTypes.Leg leg) public view returns (IDispositionExecutor) {
        IDispositionExecutor executor = _executors[leg];
        if (address(executor) == address(0)) revert NoExecutorForLeg(leg);
        return executor;
    }

    function caseOf(bytes32 caseId) external view returns (Case memory) {
        return _cases[caseId];
    }

    function orderIsFiled(bytes32 caseId, bytes32 orderHash) external view returns (bool) {
        return _filed[caseId][orderHash];
    }

    /// @notice The distinct authorities that filed into this case, in order.
    function authoritiesOf(bytes32 caseId) external view returns (address[] memory) {
        return _caseAuthorities[caseId];
    }

    /// @notice The terms of any filed order, so an adjudication can be read back.
    function filedTermsOf(bytes32 caseId, bytes32 orderHash) external view returns (Terms memory) {
        return _filedTerms[caseId][orderHash];
    }

    function nonceUsed(address authority, uint256 nonce) external view returns (bool) {
        return _usedNonces[authority][nonce];
    }

    /// @notice Whether the kernel has taken charge of a leg.
    ///
    /// @dev The escrows expose a permissionless `REVERIFY_AND_RESUME` retry that
    ///      needs no order, because it has no discretion: it can only re-attempt
    ///      the delivery the settlement already agreed to. That is safe in
    ///      isolation and unsafe the moment an order exists — a rebind resting
    ///      out its contest window would be pre-empted by anyone calling the
    ///      retry, and the value would reach the original receiver while an
    ///      authority was in the middle of deciding it should not. So the retry
    ///      asks this, and stands down while a case is live.
    ///
    ///      Stated as the two states that release the claim rather than the
    ///      three that hold it, so it closes by default: a case state added
    ///      later reads as claimed until someone decides otherwise, which is the
    ///      direction that cannot silently reopen a pre-emption window.
    function legIsClaimed(bytes32 settlementId, DispositionTypes.Leg leg)
        external
        view
        returns (bool)
    {
        CaseState state =
        _cases[DispositionOrderLib.caseIdFor(deploymentId, settlementId, leg)].state;
        return state != CaseState.NONE && state != CaseState.EXECUTED;
    }

    /// @notice The digest an authority signs.
    ///
    /// @dev Exposed so an operator can produce a signature without
    ///      reimplementing the hashing, and so a preflight can prove the order
    ///      it is about to file verifies against this contract's own domain
    ///      rather than a local copy of it. The attestation path learned this
    ///      the expensive way.
    function orderDigest(DispositionOrderLib.DispositionOrder calldata order)
        public
        view
        returns (bytes32)
    {
        DispositionOrderLib.DispositionOrder memory copy = order;
        return DispositionOrderLib.digest(domainSeparator, copy);
    }

    function resolutionDigest(DispositionOrderLib.ConflictResolution calldata resolution)
        public
        view
        returns (bytes32)
    {
        DispositionOrderLib.ConflictResolution memory copy = resolution;
        return DispositionOrderLib.digest(domainSeparator, copy);
    }

    // ── Filing ───────────────────────────────────────────────────────────────

    /// @notice Files a signed disposition order against a held leg.
    ///
    /// Permissionless to submit. The authority is the signer, never the caller,
    /// so a relayer carrying an order gains nothing by carrying it and cannot
    /// author one.
    ///
    /// Filing never moves value. It starts or joins a case, and the case decides
    /// later whether anything happens at all.
    function fileOrder(
        DispositionOrderLib.DispositionOrder calldata order,
        bytes calldata signature
    ) external returns (bytes32 orderHash) {
        _validateOrder(order);
        orderHash = orderDigest(order);

        // PRD FR-003's signature model throughout: `SignatureChecker` takes an
        // ECDSA signature from an EOA and an EIP-1271 signature from a contract
        // wallet, which is what makes the MULTISIG authority class usable.
        if (!SignatureChecker.isValidSignatureNow(order.authority, orderHash, signature)) {
            revert InvalidAuthoritySignature(order.authority);
        }

        // Consumed at filing rather than at execution. An order that was filed
        // and lost a conflict has been used; letting its nonce survive would let
        // the same signature be re-filed after the case reopened.
        if (_usedNonces[order.authority][order.nonce]) {
            revert NonceAlreadyUsed(order.authority, order.nonce);
        }
        _usedNonces[order.authority][order.nonce] = true;

        Terms memory terms = Terms({
            dispositionType: order.dispositionType,
            destination: order.destination,
            amount: order.amount,
            asset: order.asset
        });
        bytes32 termsKey = _termsKey(terms);

        _filed[order.caseId][orderHash] = true;
        _filedTerms[order.caseId][orderHash] = terms;

        Case storage dispositionCase = _cases[order.caseId];

        if (dispositionCase.state == CaseState.NONE) {
            dispositionCase.state = CaseState.OPEN;
            dispositionCase.leg = order.leg;
            dispositionCase.settlementId = order.settlementId;
            dispositionCase.policyId = order.authorityPolicyId;
            dispositionCase.policyHash = order.authorityPolicyHash;
            dispositionCase.leadTermsKey = termsKey;
            dispositionCase.leadOrderHash = orderHash;
            dispositionCase.filedAt = uint64(block.timestamp);
            dispositionCase.signatures = 1;
            _hasSigned[order.caseId][order.authority] = true;
            _caseAuthorities[order.caseId].push(order.authority);

            emit OrderFiled(
                order.caseId,
                orderHash,
                order.authority,
                order.dispositionType,
                order.destination,
                1
            );
            return orderHash;
        }

        if (
            dispositionCase.state == CaseState.EXECUTED
                || dispositionCase.state == CaseState.ADJUDICATED
        ) {
            // An adjudicated case has had its winner chosen by a resolver.
            // Accepting further filings would reopen a decision the policy has
            // already made, which is the conflict rule running backwards.
            revert CaseIsTerminal(order.caseId);
        }

        // Every order in a case must name the same policy. Otherwise a second
        // authority could file under a laxer policy and have its threshold
        // applied to the resting order's terms.
        if (order.authorityPolicyId != dispositionCase.policyId) {
            revert PolicyMismatchAcrossOrders(order.authorityPolicyId, dispositionCase.policyId);
        }

        if (dispositionCase.state == CaseState.CONTESTED) {
            // Recorded, so a resolver can choose it, and nothing else. A
            // contested case does not un-contest by agreement arriving later.
            emit OrderFiled(
                order.caseId,
                orderHash,
                order.authority,
                order.dispositionType,
                order.destination,
                dispositionCase.signatures
            );
            return orderHash;
        }

        if (termsKey != dispositionCase.leadTermsKey) {
            dispositionCase.state = CaseState.CONTESTED;
            emit CaseContested(order.caseId, dispositionCase.leadOrderHash, orderHash);
            emit OrderFiled(
                order.caseId,
                orderHash,
                order.authority,
                order.dispositionType,
                order.destination,
                dispositionCase.signatures
            );
            return orderHash;
        }

        // Agreement. This is how a two-signature policy is satisfied, and it is
        // counted per authority rather than per order so one authority cannot
        // meet its own threshold by signing twice with different nonces.
        if (_hasSigned[order.caseId][order.authority]) {
            revert AuthorityAlreadySigned(order.authority);
        }
        _hasSigned[order.caseId][order.authority] = true;
        _caseAuthorities[order.caseId].push(order.authority);
        dispositionCase.signatures += 1;

        emit OrderFiled(
            order.caseId,
            orderHash,
            order.authority,
            order.dispositionType,
            order.destination,
            dispositionCase.signatures
        );
    }

    // ── Adjudication ─────────────────────────────────────────────────────────

    /// @notice Resolves a contested case under the policy. PRD FR-012.
    ///
    /// The resolvers must agree unanimously on which filed order wins, and there
    /// must be `resolverSignatures` distinct ones from a class the policy names.
    /// Their decision replaces the contest window rather than restarting it: the
    /// window exists so a conflict can surface, and a conflict that has already
    /// surfaced and been adjudicated does not need a second chance to.
    function resolveConflict(
        bytes32 caseId,
        DispositionOrderLib.ConflictResolution[] calldata resolutions,
        bytes[] calldata signatures
    ) external {
        Case storage dispositionCase = _cases[caseId];
        if (dispositionCase.state != CaseState.CONTESTED) {
            revert CaseNotContested(caseId, dispositionCase.state);
        }
        if (resolutions.length == 0) revert NoResolutionsProvided();
        if (resolutions.length != signatures.length) {
            revert ResolutionsDisagree(bytes32(0), bytes32(0));
        }

        AuthorityRegistry.AuthorityPolicy memory policy =
            registry.policyOf(dispositionCase.policyId);
        // Read once. Inside the loop it is both wasted gas and a value that
        // could in principle differ between iterations, which would make the
        // check depend on how many resolvers happened to sign.
        bytes32 currentPolicyHash = registry.policyHash(dispositionCase.policyId);
        bytes32 winner = resolutions[0].winningOrderHash;

        // Every resolver's class, asked once. Per-resolver it would be an
        // external call inside a loop, and the registry owns the storage anyway,
        // so iterating there is a warm read rather than a call frame each time.
        _requireResolverClasses(resolutions);

        address[] memory counted = new address[](resolutions.length);
        uint256 distinct = 0;

        for (uint256 i = 0; i < resolutions.length; i += 1) {
            DispositionOrderLib.ConflictResolution calldata resolution = resolutions[i];

            // Unanimity, not majority. A split among resolvers is another
            // conflict, and resolving it by counting would let the kernel pick
            // an outcome the authorities did not agree on.
            if (resolution.winningOrderHash != winner) {
                revert ResolutionsDisagree(winner, resolution.winningOrderHash);
            }
            _validateResolution(
                resolution, caseId, dispositionCase.policyId, currentPolicyHash, policy
            );
            distinct = _countResolver(resolution, signatures[i], counted, distinct);
        }

        if (distinct < policy.resolverSignatures) {
            revert SignaturesBelowThreshold(distinct, policy.resolverSignatures);
        }
        if (!_filed[caseId][winner]) revert OrderNotFiled(caseId, winner);

        dispositionCase.leadOrderHash = winner;
        dispositionCase.leadTermsKey = _termsKey(_filedTerms[caseId][winner]);
        dispositionCase.state = CaseState.ADJUDICATED;

        emit CaseAdjudicated(caseId, winner);
    }

    /// @dev Consumes one resolver's nonce, verifies its signature, and counts it
    ///      once.
    ///
    ///      The nonce is burned before the signature is checked, so a resolution
    ///      that fails verification still costs its nonce — there is no cheap
    ///      retry loop against a contested case. `counted` is a memory array and
    ///      therefore by reference, so the caller sees the append.
    function _countResolver(
        DispositionOrderLib.ConflictResolution calldata resolution,
        bytes calldata signature,
        address[] memory counted,
        uint256 distinct
    ) private returns (uint256) {
        if (_usedNonces[resolution.authority][resolution.nonce]) {
            revert NonceAlreadyUsed(resolution.authority, resolution.nonce);
        }
        _usedNonces[resolution.authority][resolution.nonce] = true;

        bytes32 digest = resolutionDigest(resolution);
        if (!SignatureChecker.isValidSignatureNow(resolution.authority, digest, signature)) {
            revert InvalidAuthoritySignature(resolution.authority);
        }

        // Distinct authorities, not distinct signatures. One resolver signing
        // twice with two nonces is one opinion, and a threshold satisfied that
        // way would be a threshold of one wearing two hats.
        for (uint256 j = 0; j < distinct; j += 1) {
            if (counted[j] == resolution.authority) {
                revert AuthorityAlreadySigned(resolution.authority);
            }
        }
        counted[distinct] = resolution.authority;
        return distinct + 1;
    }

    /// @dev One resolution's bindings, split out of the loop so `resolveConflict`
    ///      stays readable and its branch count stays reviewable. Every check
    ///      here has the same shape as the order's: the resolution names the
    ///      case, the generation, the policy and its content, and is valid now.
    function _validateResolution(
        DispositionOrderLib.ConflictResolution calldata resolution,
        bytes32 caseId,
        bytes32 policyId,
        bytes32 currentPolicyHash,
        AuthorityRegistry.AuthorityPolicy memory policy
    ) private view {
        if (resolution.caseId != caseId) {
            revert CaseIdMismatch(resolution.caseId, caseId);
        }
        if (resolution.deploymentId != deploymentId) {
            revert WrongDeployment(resolution.deploymentId, deploymentId);
        }
        if (resolution.authorityPolicyId != policyId) {
            revert PolicyMismatchAcrossOrders(resolution.authorityPolicyId, policyId);
        }
        if (resolution.authorityPolicyHash != currentPolicyHash) {
            revert PolicyHashMismatch(resolution.authorityPolicyHash, currentPolicyHash);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < resolution.notBefore) {
            revert OrderNotYetValid(resolution.notBefore, block.timestamp);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > resolution.expiry) {
            revert OrderExpired(resolution.expiry, block.timestamp);
        }
        if (!policy.resolverAuthorityTypes.permits(resolution.authorityType)) {
            revert AuthorityTypeNotPermitted(resolution.authorityType);
        }
    }

    /// @dev Collects the claimed classes and puts them to the registry in one
    ///      call, so the registry checks each against its own storage. Splitting
    ///      it out of the per-resolution checks is not cosmetic: it is what keeps
    ///      an external call out of the adjudication loop.
    function _requireResolverClasses(DispositionOrderLib.ConflictResolution[] calldata resolutions)
        private
        view
    {
        address[] memory accounts = new address[](resolutions.length);
        DispositionTypes.AuthorityType[] memory claimed =
            new DispositionTypes.AuthorityType[](resolutions.length);
        for (uint256 i = 0; i < resolutions.length; i += 1) {
            accounts[i] = resolutions[i].authority;
            claimed[i] = resolutions[i].authorityType;
        }
        registry.requireAuthorities(accounts, claimed);
    }

    // ── Execution ────────────────────────────────────────────────────────────

    /// @notice Executes the case's winning order.
    ///
    /// Permissionless, like every other value-moving path in Conduit (PRD
    /// FR-009). The caller supplies the compliance proof and nothing else that
    /// matters: the type, destination, amount and asset all come from the case,
    /// which came from a signed order.
    ///
    /// The held leg and the host-state version are re-read here rather than
    /// trusted from filing time. An order authorized against one state must not
    /// execute against another, and the window between filing and execution is
    /// exactly as long as the policy's contest window.
    function executeOrder(bytes32 caseId, ComplianceAuthority.ComplianceProof calldata compliance)
        external
        nonReentrant
    {
        Case storage dispositionCase = _cases[caseId];

        if (dispositionCase.state == CaseState.EXECUTED) revert CaseIsTerminal(caseId);
        if (dispositionCase.state == CaseState.CONTESTED) {
            revert CaseNotOpen(caseId, CaseState.CONTESTED);
        }
        if (
            dispositionCase.state != CaseState.OPEN
                && dispositionCase.state != CaseState.ADJUDICATED
        ) {
            revert CaseNotOpen(caseId, dispositionCase.state);
        }

        AuthorityRegistry.AuthorityPolicy memory policy =
            registry.policyOf(dispositionCase.policyId);
        Terms memory terms = _filedTerms[caseId][dispositionCase.leadOrderHash];

        if (dispositionCase.state == CaseState.OPEN) {
            uint64 openUntil = dispositionCase.filedAt + policy.contestWindow;
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < openUntil) revert ContestWindowOpen(openUntil, block.timestamp);

            uint8 required = policy.requiredSignatures[uint8(terms.dispositionType)];
            if (dispositionCase.signatures < required) {
                revert SignaturesBelowThreshold(dispositionCase.signatures, required);
            }
        }

        IDispositionExecutor executor = executorFor(dispositionCase.leg);
        IDispositionExecutor.HeldLeg memory held = executor.heldLegOf(dispositionCase.settlementId);

        // Still held, still the same value, still going to the same party the
        // order displaced. Anything that changed between filing and now means
        // the authority signed about a different situation.
        if (!held.held) revert LegNotHeld(dispositionCase.settlementId);
        if (held.asset != terms.asset) revert AssetMismatch(terms.asset, held.asset);
        if (held.amount != terms.amount) revert AmountMismatch(terms.amount, held.amount);

        // Effects before interaction. The case is terminal before the executor
        // is called, so a re-entrant execution finds a closed case rather than
        // an open one — and `nonReentrant` covers the same ground independently.
        dispositionCase.state = CaseState.EXECUTED;
        dispositionCase.executedOrderHash = dispositionCase.leadOrderHash;
        dispositionCase.executedType = terms.dispositionType;
        dispositionCase.executedDestination = terms.destination;
        dispositionCase.executedAmount = terms.amount;
        dispositionCase.executedComplianceDigest = keccak256(abi.encode(compliance));

        executor.executeDisposition(
            dispositionCase.settlementId,
            terms.dispositionType,
            terms.destination,
            terms.amount,
            compliance
        );

        emit DispositionExecuted(
            caseId,
            dispositionCase.settlementId,
            dispositionCase.leadOrderHash,
            terms.dispositionType,
            terms.destination,
            terms.amount
        );
    }

    // ── Validation ───────────────────────────────────────────────────────────

    function _termsKey(Terms memory terms) private pure returns (bytes32) {
        return keccak256(
            abi.encode(uint8(terms.dispositionType), terms.destination, terms.amount, terms.asset)
        );
    }

    /// @dev Everything an order must be true about before it is allowed to rest
    ///      in a case. Split out because `fileOrder` otherwise exceeds the stack,
    ///      and because these are the checks an auditor reads first.
    /// @dev Returns nothing. The policy is read to check this order against it,
    ///      and the threshold it carries belongs to execution rather than to
    ///      filing: a case's signature count is compared with the policy at the
    ///      moment value would move, not at the moment an authority signs.
    function _validateOrder(DispositionOrderLib.DispositionOrder calldata order) private view {
        if (order.deploymentId != deploymentId) {
            revert WrongDeployment(order.deploymentId, deploymentId);
        }

        // Derived, never chosen. Two orders about one piece of held value land
        // in one case by construction, so the conflict check cannot be evaded by
        // filing somewhere else.
        bytes32 derived = DispositionOrderLib.caseIdFor(deploymentId, order.settlementId, order.leg);
        if (order.caseId != derived) revert CaseIdMismatch(order.caseId, derived);

        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < order.notBefore) {
            revert OrderNotYetValid(order.notBefore, block.timestamp);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > order.expiry) revert OrderExpired(order.expiry, block.timestamp);

        AuthorityRegistry.AuthorityPolicy memory policy = registry.policyOf(order.authorityPolicyId);
        bytes32 currentPolicyHash = registry.policyHash(order.authorityPolicyId);
        if (order.authorityPolicyHash != currentPolicyHash) {
            revert PolicyHashMismatch(order.authorityPolicyHash, currentPolicyHash);
        }
        if (!policy.allowedAuthorityTypes.permits(order.authorityType)) {
            revert AuthorityTypeNotPermitted(order.authorityType);
        }
        if (policy.requiredSignatures[uint8(order.dispositionType)] == 0) {
            revert DispositionTypeNotPermitted(order.dispositionType);
        }

        // The class is checked against the registry, not taken from the order.
        // An order claiming ISSUER from an address registered as SUBJECT names
        // the mismatch rather than falling through to the registered class.
        registry.requireAuthority(order.authority, order.authorityType);

        _requireHeldLegMatches(order);
    }

    function _requireHeldLegMatches(DispositionOrderLib.DispositionOrder calldata order)
        private
        view
    {
        IDispositionExecutor executor = executorFor(order.leg);
        if (order.sourceEscrow != address(executor)) {
            revert SourceEscrowMismatch(order.sourceEscrow, address(executor));
        }

        IDispositionExecutor.HeldLeg memory held = executor.heldLegOf(order.settlementId);
        if (!held.held) revert LegNotHeld(order.settlementId);

        uint64 version = executor.hostStateVersion(order.settlementId);
        if (order.hostStateVersion != version) {
            revert HostStateVersionMismatch(order.hostStateVersion, version);
        }

        // The amount and the asset are the held leg's, not the order's. This is
        // the binding that stops a disposition order from being a transfer
        // instruction: an authority signs about the value that is stuck, and
        // cannot sign about a different amount of it.
        if (order.asset != held.asset) revert AssetMismatch(order.asset, held.asset);
        if (order.amount != held.amount) revert AmountMismatch(order.amount, held.amount);
        if (order.currentReceiver != held.currentReceiver) {
            revert CurrentReceiverMismatch(order.currentReceiver, held.currentReceiver);
        }

        _requireDestinationPermitted(order, held);
    }

    /// @dev Where each order type is allowed to send value, and only there.
    ///
    ///      This function is the difference between six order types and one
    ///      order type with a free destination field. Each branch answers to a
    ///      different registry list maintained by a different authority class,
    ///      so an issuer's power to approve substitutes is not a gateway
    ///      operator's power to approve off-ramp accounts, and neither is a
    ///      power to send value to an address of their choosing.
    function _requireDestinationPermitted(
        DispositionOrderLib.DispositionOrder calldata order,
        IDispositionExecutor.HeldLeg memory held
    ) private view {
        DispositionTypes.DispositionType dispositionType = order.dispositionType;

        if (dispositionType == DispositionTypes.DispositionType.REVERIFY_AND_RESUME) {
            // No redirect at all. The order authorizes a retry of the delivery
            // the settlement already named, which is why this type needs the
            // weakest authority and why the escrows can also offer it
            // permissionlessly when no case is open.
            if (order.destination != held.currentReceiver) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            return;
        }

        if (dispositionType == DispositionTypes.DispositionType.REBIND_RECEIVER) {
            // PRD 5.4. Same legal identity, different wallet. The commitment is
            // what makes it a rebind: if the replacement carried a different
            // commitment this would be a substitution, which is a different
            // order type under a different authority.
            if (order.destination == held.currentReceiver) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            bytes32 replacement = registry.identityCommitmentOf(order.destination);
            bytes32 original = registry.identityCommitmentOf(held.currentReceiver);
            if (replacement == bytes32(0) || replacement != original) {
                revert IdentityCommitmentMismatch(replacement, original);
            }
            if (order.destinationIdentityCommitment != replacement) {
                revert IdentityCommitmentMismatch(order.destinationIdentityCommitment, replacement);
            }
            return;
        }

        if (dispositionType == DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER) {
            // Not a refund. A refund is a pre-COMMIT unwind that PRD FR-008
            // permanently disables once a COMMIT exists; this is an authorized
            // post-COMMIT disposition that happens to send value back the way it
            // came. The COMMIT stays on chain as historical fact, the settlement
            // never becomes ABORTED, and the leg records DISPOSED rather than
            // RETURNED. Requiring the COMMIT here is what keeps the two apart:
            // without it, this order type would be a refund with a different
            // name.
            if (!held.committed) revert ReturnRequiresCommit(order.settlementId);
            if (order.destination != held.originalSender) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            return;
        }

        if (dispositionType == DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION) {
            // PRD 4.3 and 12.x: a wallet the issuer or transfer agent has
            // approved as a substitute *for this receiver*. A global approved
            // list would make one approval good against every held settlement in
            // the system, which is the drain this type has to not become.
            if (order.destination == held.currentReceiver) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            if (!registry.isApprovedSubstitute(held.currentReceiver, order.destination)) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            return;
        }

        if (dispositionType == DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP) {
            // PRD 5.5. The last on-chain hop is a registered institution
            // account; the fiat leg after it is off chain and is not claimed by
            // anything here.
            if (!registry.isGatewayAccount(order.destination)) {
                revert DestinationNotPermitted(dispositionType, order.destination);
            }
            return;
        }

        // RESTRICTED_HOLD. PRD 5.3's `SETTLED_TO_RESTRICTED_CUSTODY`. A
        // deliberate terminal outcome, not an absence of one: the value moves to
        // a registered custodian, the case closes, and the leg is DISPOSED. A
        // leg left sitting in HELD is the opposite — an unresolved case, and the
        // verifier reports the two differently for exactly that reason.
        if (!registry.isRestrictedCustodian(order.destination)) {
            revert DestinationNotPermitted(dispositionType, order.destination);
        }
    }
}
