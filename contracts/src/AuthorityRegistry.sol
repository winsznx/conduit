// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {DISPOSITION_TYPE_COUNT, DispositionTypes} from "./libraries/DispositionTypes.sol";

/// @notice Who may sign a disposition order, for what, and where value may go.
///         PRD 8.1, FR-012, and persona sections 4.3 and 4.4.
///
/// The Disposition Kernel's whole reason to exist is that held value must not be
/// released by "an operator calls a function". This contract is the other half
/// of that sentence: it says which addresses hold which of PRD FR-012's seven
/// authority classes, which order types each class may sign under a named
/// policy, how many distinct signatures each type needs, and — for the three
/// order types that send value to somewhere the settlement never named — which
/// destinations are permissible at all.
///
/// **Nothing here can move value.** The registry has no token, no escrow
/// reference and no execution path. Its worst case is authorizing the wrong
/// signer for a future order, and the controller still requires the order to be
/// signed, unexpired, uncontested, and backed by fresh compliance at execution.
///
/// **Grants are timelocked, revocations are immediate.** PRD FR-006 already
/// requires timelocked signer-set changes for the compliance quorum, and the
/// same argument applies with more force here: an untimelocked grant would let
/// the registry owner add itself as an ISSUER, sign an AUTHORIZED_SUBSTITUTION,
/// and take a held bond inside one transaction. With the delay, the grant is
/// visible on chain for the whole window and the contest window sits on top of
/// it. Revocation is instant in the other direction because the fail-safe
/// direction of an access-control change should never be delayed.
///
/// **Destinations are allow-listed per order type, not in general.** A single
/// "approved address" set would make an ISSUER's substitution authority and a
/// GATEWAY_OPERATOR's off-ramp authority interchangeable. They are not, and the
/// distinction is precisely what stops a disposition order from becoming a
/// generic drain authorization.
contract AuthorityRegistry is Ownable2Step {
    using DispositionTypes for uint16;

    /// @notice PRD FR-012's authority classes, plus liveness.
    struct Authority {
        DispositionTypes.AuthorityType authorityType;
        bool active;
        uint64 activatedAt;
    }

    /// @notice A named policy. PRD FR-012's `authority policy ID`.
    ///
    /// @dev `requiredSignatures[type] == 0` means the policy does not permit
    ///      that order type at all. One field carrying both the permission and
    ///      the threshold removes the state where a type is allowed but needs
    ///      zero signatures, which is the shape a separate boolean would let a
    ///      misconfiguration reach.
    struct AuthorityPolicy {
        bool active;
        /// @dev How long a filed order must rest before it can execute. The
        ///      conflict rule is meaningless without it: whoever submits first
        ///      would simply win, and PRD FR-012 says conflicting valid orders
        ///      produce CONTESTED rather than a race.
        uint32 contestWindow;
        /// @dev Bitmask over `AuthorityType`. Which classes may sign at all.
        uint16 allowedAuthorityTypes;
        /// @dev Bitmask over `AuthorityType`. Which classes may adjudicate a
        ///      contested case. Kept separate so the classes that can create a
        ///      conflict are not automatically the ones that resolve it.
        uint16 resolverAuthorityTypes;
        uint8 resolverSignatures;
        uint8[DISPOSITION_TYPE_COUNT] requiredSignatures;
    }

    /// @notice A grant waiting out `grantDelay`.
    ///
    /// @dev `exists` rather than a zero `effectiveAt` sentinel. A sentinel makes
    ///      "no pending grant" and "a grant maturing at the epoch" the same
    ///      value, and it makes the check that decides whether a grant exists a
    ///      strict equality against a timestamp — which reads, correctly, as the
    ///      shape of a bug even when it is not one here.
    struct PendingGrant {
        bool exists;
        uint64 effectiveAt;
        DispositionTypes.AuthorityType authorityType;
    }

    /// @notice How long a grant waits before it takes effect.
    uint64 public immutable grantDelay;

    mapping(address account => Authority) private _authorities;
    mapping(address account => PendingGrant) private _pendingAuthority;

    mapping(bytes32 policyId => AuthorityPolicy) private _policies;

    /// @dev REBIND_RECEIVER only. PRD 5.4: a replacement wallet for the same
    ///      legal identity. The commitment is the identity, the address is the
    ///      wallet, and a rebind is exactly a change of the second with the
    ///      first held constant.
    mapping(address account => bytes32 commitment) private _identityCommitments;

    /// @dev AUTHORIZED_SUBSTITUTION only, and keyed by the receiver being
    ///      substituted rather than globally. PRD 12.x lists "approved
    ///      substitute wallets" in the registry; approving a wallet as a
    ///      substitute for one counterparty is not approving it for every held
    ///      settlement in the system.
    mapping(address original => mapping(address substitute => bool)) private _approvedSubstitutes;

    /// @dev RESTRICTED_HOLD only. PRD 5.3's `SETTLED_TO_RESTRICTED_CUSTODY`.
    mapping(address account => bool) private _restrictedCustodians;

    /// @dev OPERATOR_ASSISTED_OFFRAMP only. PRD 5.5's institution deposit
    ///      address, which is the last on-chain hop before the fiat leg.
    mapping(address account => bool) private _gatewayAccounts;

    mapping(bytes32 key => PendingGrant) private _pendingDestination;

    event AuthorityProposed(
        address indexed account, DispositionTypes.AuthorityType authorityType, uint64 effectiveAt
    );
    event AuthorityActivated(address indexed account, DispositionTypes.AuthorityType authorityType);
    event AuthorityRevoked(address indexed account);
    event PolicySet(bytes32 indexed policyId, bytes32 policyHash);
    event PolicyRetired(bytes32 indexed policyId);
    event IdentityCommitmentSet(address indexed account, bytes32 commitment);
    event DestinationProposed(bytes32 indexed key, uint64 effectiveAt);
    event SubstituteApproved(address indexed original, address indexed substitute);
    event SubstituteRevoked(address indexed original, address indexed substitute);
    event RestrictedCustodianSet(address indexed account, bool approved);
    event GatewayAccountSet(address indexed account, bool approved);

    error ZeroAddress();
    error AuthorityAlreadyActive(address account);
    error NoPendingAuthority(address account);
    error GrantNotMatured(uint64 effectiveAt, uint256 nowTimestamp);
    error NotAnAuthority(address account);
    error AuthorityTypeMismatch(
        DispositionTypes.AuthorityType expected, DispositionTypes.AuthorityType actual
    );
    error PolicyUnknown(bytes32 policyId);
    error PolicyIdIsZero();
    error PolicyPermitsNothing(bytes32 policyId);
    error PolicyResolverUnsatisfiable(bytes32 policyId);
    error NoPendingDestination(bytes32 key);
    error NotPermittedToRegisterDestinations(address account);
    error AuthorityCountMismatch(uint256 accounts, uint256 authorityTypes);

    constructor(address owner_, uint64 grantDelay_) Ownable(owner_) {
        grantDelay = grantDelay_;
    }

    // ── Authority classes ────────────────────────────────────────────────────

    /// @notice Starts the clock on a grant. PRD FR-006's timelock, applied here.
    function proposeAuthority(address account, DispositionTypes.AuthorityType authorityType)
        external
        onlyOwner
    {
        if (account == address(0)) revert ZeroAddress();
        if (_authorities[account].active) revert AuthorityAlreadyActive(account);

        uint64 effectiveAt = uint64(block.timestamp) + grantDelay;
        _pendingAuthority[account] =
            PendingGrant({exists: true, effectiveAt: effectiveAt, authorityType: authorityType});

        emit AuthorityProposed(account, authorityType, effectiveAt);
    }

    /// @notice Completes a matured grant.
    ///
    /// @dev Permissionless. The decision was the proposal; making the second
    ///      call an owner-only step would add a liveness dependency without
    ///      adding safety, and the type and the maturity are both fixed by the
    ///      proposal.
    function activateAuthority(address account) external {
        PendingGrant memory pending = _pendingAuthority[account];
        if (!pending.exists) revert NoPendingAuthority(account);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.effectiveAt) {
            revert GrantNotMatured(pending.effectiveAt, block.timestamp);
        }

        delete _pendingAuthority[account];

        _authorities[account] = Authority({
            authorityType: pending.authorityType, active: true, activatedAt: uint64(block.timestamp)
        });

        emit AuthorityActivated(account, pending.authorityType);
    }

    /// @notice Removes an authority immediately, and any pending grant with it.
    function revokeAuthority(address account) external onlyOwner {
        delete _authorities[account];
        delete _pendingAuthority[account];
        emit AuthorityRevoked(account);
    }

    function authorityOf(address account) external view returns (Authority memory) {
        return _authorities[account];
    }

    function pendingAuthorityAt(address account) external view returns (uint64) {
        return _pendingAuthority[account].effectiveAt;
    }

    /// @notice Reverts unless `account` currently holds exactly `authorityType`.
    ///
    /// @dev The controller asks this rather than reading the struct, so a
    ///      revoked authority and an authority of a different class produce
    ///      distinct errors. "This signer was never authorized" and "this signer
    ///      is an ISSUER claiming to be a GATEWAY_OPERATOR" are different
    ///      findings in an audit.
    function requireAuthority(address account, DispositionTypes.AuthorityType authorityType)
        external
        view
    {
        Authority storage authority = _authorities[account];
        if (!authority.active) revert NotAnAuthority(account);
        if (authority.authorityType != authorityType) {
            revert AuthorityTypeMismatch(authorityType, authority.authorityType);
        }
    }

    /// @notice `requireAuthority` for a set, in one call.
    ///
    /// @dev The conflict adjudication path checks one class per resolver, and
    ///      asking the registry once per resolver puts an external call inside a
    ///      loop — a shape worth avoiding on its own, and the loop belongs here
    ///      anyway: this contract owns the storage being read, so the iteration
    ///      costs a warm SLOAD rather than a call frame.
    function requireAuthorities(
        address[] calldata accounts,
        DispositionTypes.AuthorityType[] calldata authorityTypes
    ) external view {
        if (accounts.length != authorityTypes.length) {
            revert AuthorityCountMismatch(accounts.length, authorityTypes.length);
        }
        for (uint256 i = 0; i < accounts.length; i += 1) {
            Authority storage authority = _authorities[accounts[i]];
            if (!authority.active) revert NotAnAuthority(accounts[i]);
            if (authority.authorityType != authorityTypes[i]) {
                revert AuthorityTypeMismatch(authorityTypes[i], authority.authorityType);
            }
        }
    }

    // ── Policies ─────────────────────────────────────────────────────────────

    /// @notice Creates or replaces a named policy.
    ///
    /// @dev Not timelocked, and deliberately so: an order binds the policy
    ///      *hash*, so changing a policy does not repurpose orders signed under
    ///      the old one, it invalidates them. That is the safe direction, and it
    ///      makes tightening a policy an immediate operation rather than one
    ///      that has to wait out a delay while a bad configuration is live.
    function setPolicy(bytes32 policyId, AuthorityPolicy calldata policy) external onlyOwner {
        if (policyId == bytes32(0)) revert PolicyIdIsZero();

        bool permitsSomething = false;
        for (uint256 i = 0; i < DISPOSITION_TYPE_COUNT; i += 1) {
            if (policy.requiredSignatures[i] != 0) {
                permitsSomething = true;
                break;
            }
        }
        // A policy that permits no order type is not a restrictive policy, it is
        // an inert one that reads as configuration while doing nothing. Every
        // filing under it would fail with a per-type error rather than saying
        // the policy is empty.
        if (!permitsSomething || policy.allowedAuthorityTypes == 0) {
            revert PolicyPermitsNothing(policyId);
        }
        // A contested case under a policy with no resolver can never leave
        // CONTESTED, which turns a conflict into permanent loss of the held
        // value. PRD 7.1 lists CONTESTED -> SETTLED as a transition that must
        // exist.
        if (policy.resolverAuthorityTypes == 0 || policy.resolverSignatures == 0) {
            revert PolicyResolverUnsatisfiable(policyId);
        }

        _policies[policyId] = policy;
        _policies[policyId].active = true;

        emit PolicySet(policyId, policyHash(policyId));
    }

    /// @notice Deactivates a policy. Orders bound to it stop being fileable.
    function retirePolicy(bytes32 policyId) external onlyOwner {
        if (!_policies[policyId].active) revert PolicyUnknown(policyId);
        _policies[policyId].active = false;
        emit PolicyRetired(policyId);
    }

    function policyOf(bytes32 policyId) external view returns (AuthorityPolicy memory) {
        AuthorityPolicy memory policy = _policies[policyId];
        if (!policy.active) revert PolicyUnknown(policyId);
        return policy;
    }

    /// @notice The content hash an order binds.
    ///
    /// @dev Covers the policy ID as well as the fields, so two policies with
    ///      identical rules hash differently. An order names one policy and no
    ///      other, even where another would have permitted the same thing.
    function policyHash(bytes32 policyId) public view returns (bytes32) {
        AuthorityPolicy storage policy = _policies[policyId];
        return keccak256(
            abi.encode(
                policyId,
                policy.active,
                policy.contestWindow,
                policy.allowedAuthorityTypes,
                policy.resolverAuthorityTypes,
                policy.resolverSignatures,
                policy.requiredSignatures
            )
        );
    }

    // ── Identity commitments, for REBIND_RECEIVER ────────────────────────────

    /// @notice Records the identity a wallet belongs to. PRD 5.4 step 3.
    ///
    /// @dev Only a TRANSFER_AGENT or a COMPLIANCE_OPERATOR may assert that two
    ///      wallets are the same legal person, because that assertion is the
    ///      entire safety property of a rebind. PRD 4.3 and 4.4 place the
    ///      operator process with exactly those two personas.
    ///
    ///      Not timelocked: it is a claim about identity, not a grant of
    ///      authority, and the rebind that uses it is itself timelocked by the
    ///      contest window and gated on the replacement passing fresh
    ///      compliance at execution.
    function setIdentityCommitment(address account, bytes32 commitment) external {
        _requireDestinationRegistrar();
        if (account == address(0)) revert ZeroAddress();
        _identityCommitments[account] = commitment;
        emit IdentityCommitmentSet(account, commitment);
    }

    function identityCommitmentOf(address account) external view returns (bytes32) {
        return _identityCommitments[account];
    }

    // ── Destination allow-lists ──────────────────────────────────────────────
    //
    // Three lists rather than one, keyed by the order type that may use them.
    // Merging them would make an issuer's substitution authority and a gateway
    // operator's off-ramp authority interchangeable, which is the precise shape
    // of a disposition order becoming a generic drain.
    //
    // Additions wait out `grantDelay` for the same reason authority grants do:
    // approving a destination and immediately signing an order that sends value
    // to it is one transaction otherwise.

    function proposeSubstitute(address original, address substitute) external {
        _requireIssuerOrTransferAgent();
        if (original == address(0) || substitute == address(0)) revert ZeroAddress();
        _proposeDestination(_substituteKey(original, substitute));
    }

    function activateSubstitute(address original, address substitute) external {
        _activateDestination(_substituteKey(original, substitute));
        _approvedSubstitutes[original][substitute] = true;
        emit SubstituteApproved(original, substitute);
    }

    function revokeSubstitute(address original, address substitute) external {
        _requireIssuerOrTransferAgent();
        delete _approvedSubstitutes[original][substitute];
        delete _pendingDestination[_substituteKey(original, substitute)];
        emit SubstituteRevoked(original, substitute);
    }

    function isApprovedSubstitute(address original, address substitute)
        external
        view
        returns (bool)
    {
        return _approvedSubstitutes[original][substitute];
    }

    function proposeRestrictedCustodian(address account) external {
        _requireDestinationRegistrar();
        if (account == address(0)) revert ZeroAddress();
        _proposeDestination(_custodianKey(account));
    }

    function activateRestrictedCustodian(address account) external {
        _activateDestination(_custodianKey(account));
        _restrictedCustodians[account] = true;
        emit RestrictedCustodianSet(account, true);
    }

    function revokeRestrictedCustodian(address account) external {
        _requireDestinationRegistrar();
        delete _restrictedCustodians[account];
        delete _pendingDestination[_custodianKey(account)];
        emit RestrictedCustodianSet(account, false);
    }

    function isRestrictedCustodian(address account) external view returns (bool) {
        return _restrictedCustodians[account];
    }

    function proposeGatewayAccount(address account) external {
        _requireGatewayOperator();
        if (account == address(0)) revert ZeroAddress();
        _proposeDestination(_gatewayKey(account));
    }

    function activateGatewayAccount(address account) external {
        _activateDestination(_gatewayKey(account));
        _gatewayAccounts[account] = true;
        emit GatewayAccountSet(account, true);
    }

    function revokeGatewayAccount(address account) external {
        _requireGatewayOperator();
        delete _gatewayAccounts[account];
        delete _pendingDestination[_gatewayKey(account)];
        emit GatewayAccountSet(account, false);
    }

    function isGatewayAccount(address account) external view returns (bool) {
        return _gatewayAccounts[account];
    }

    function pendingDestinationAt(bytes32 key) external view returns (uint64) {
        return _pendingDestination[key].effectiveAt;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _substituteKey(address original, address substitute) private pure returns (bytes32) {
        return keccak256(abi.encode("substitute", original, substitute));
    }

    function _custodianKey(address account) private pure returns (bytes32) {
        return keccak256(abi.encode("custodian", account));
    }

    function _gatewayKey(address account) private pure returns (bytes32) {
        return keccak256(abi.encode("gateway", account));
    }

    function _proposeDestination(bytes32 key) private {
        uint64 effectiveAt = uint64(block.timestamp) + grantDelay;
        _pendingDestination[key] = PendingGrant({
            exists: true,
            effectiveAt: effectiveAt,
            authorityType: DispositionTypes.AuthorityType.SUBJECT
        });
        emit DestinationProposed(key, effectiveAt);
    }

    function _activateDestination(bytes32 key) private {
        PendingGrant memory pending = _pendingDestination[key];
        if (!pending.exists) revert NoPendingDestination(key);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.effectiveAt) {
            revert GrantNotMatured(pending.effectiveAt, block.timestamp);
        }
        delete _pendingDestination[key];
    }

    /// @dev The owner is included because a deployment has to be able to seed
    ///      the first entries before any authority exists to do it. That is the
    ///      bootstrap, it is visible in the constructor's owner, and every use
    ///      of it still waits out `grantDelay`.
    function _requireDestinationRegistrar() private view {
        if (msg.sender == owner()) return;
        Authority storage authority = _authorities[msg.sender];
        if (
            !authority.active
                || (authority.authorityType != DispositionTypes.AuthorityType.TRANSFER_AGENT
                    && authority.authorityType
                        != DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR)
        ) {
            revert NotPermittedToRegisterDestinations(msg.sender);
        }
    }

    /// @dev PRD 4.3: the issuer or transfer agent signs authorized-substitution
    ///      orders, so the same two personas decide who may be substituted in.
    function _requireIssuerOrTransferAgent() private view {
        if (msg.sender == owner()) return;
        Authority storage authority = _authorities[msg.sender];
        if (
            !authority.active
                || (authority.authorityType != DispositionTypes.AuthorityType.ISSUER
                    && authority.authorityType != DispositionTypes.AuthorityType.TRANSFER_AGENT)
        ) {
            revert NotPermittedToRegisterDestinations(msg.sender);
        }
    }

    function _requireGatewayOperator() private view {
        if (msg.sender == owner()) return;
        Authority storage authority = _authorities[msg.sender];
        if (
            !authority.active
                || authority.authorityType != DispositionTypes.AuthorityType.GATEWAY_OPERATOR
        ) {
            revert NotPermittedToRegisterDestinations(msg.sender);
        }
    }
}
