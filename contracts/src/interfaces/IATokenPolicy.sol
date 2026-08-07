// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

/// @dev IComplianceRule (RuleV2-only view; developers do not need to care about
///      the legacy Rule).
///
/// Transcribed verbatim from the Cleanverse Compliance Protocol (CCP) CVA
/// Integration Guide, which the v1.1 override ranks above Cleanverse API V5.6
/// for RuleV2 semantics. Field order, types, and names are the ABI contract with
/// the deployed policy and must not be "tidied".
///
/// Only the pragma differs from the guide: it prints `^0.8.24`, and this
/// repository pins every first-party file to the exact compiler in
/// toolchain.json. The ABI is unaffected.
interface IComplianceRule {
    /// @dev SIX fields, not the five the guide declares.
    ///
    /// The guide's `IComplianceRule` listing omits `isBlackList` and its API
    /// table calls the field "Deprecated; always pass false. Replaced by
    /// poolCountryBitmap". The deployed policy still carries it in the struct.
    ///
    /// Read from the live Base Sepolia policy
    /// `0x36489be45fa84f70a0c2bdb11d824be608cb12dd` on 2026-08-07 via
    /// `getRulesV2`. A five-field decode of a real rule fails outright, because
    /// the 256-bit country bitmap lands in the slot a `uint8` was expected in:
    ///
    ///   (bytes2,bytes2,uint8,uint8,bool,uint256)  decodes 2 rules
    ///   (bytes2,bytes2,uint8,uint8,uint256)       fails
    ///
    /// Encoding five fields into a six-field call is not a cosmetic mismatch.
    /// `setRuleV2FromToken` would either revert or write a rule nobody intended,
    /// and a silently wrong compliance rule is the worst outcome available here.
    /// ADR-0010 records the evidence.
    struct RuleV2 {
        bytes2 allowedGroup; //   0x0000 = unrestricted
        bytes2 allowedSubGroup; // 0x0000 = unrestricted
        uint8 minTier; //         0 = unrestricted; range 0-99
        uint8 minSubTier; //      0 = unrestricted; range 0-99
        bool isBlackList; //      deprecated upstream, still in the deployed struct
        uint256 poolCountryBitmap; // 0 = unrestricted; bitwise AND check
    }
}

/// @notice The Cleanverse policy engine every CVA transfer is gated through.
///
/// Rules are held per token as a `RuleV2[]` evaluated under OR semantics: a
/// holder is compliant if they satisfy any one rule. That is what makes
/// differentiated access paths expressible — a regional exemption and an
/// institutional whitelist coexist as two rules rather than one merged rule.
///
/// `poolCountryBitmap` is deliberately not constructed anywhere in this
/// repository. The guide states bit positions correspond to ISO 3166-1 numeric
/// codes, which run to 894 against a 256-bit field, and supplies no index table.
/// Its own worked example is self-contradictory: `countries: ["US","SG"]` is
/// described as allowing US and SG users while also stating a zero bitmap means
/// no country restriction. Conduit therefore treats the encoding as unresolved,
/// passes `0`, and makes no country-enforcement claim. See ASM-025.
interface IATokenPolicy is IComplianceRule {
    error TransferNotAllowed();

    function canTransfer(address token, address from, address to, uint256 amount)
        external
        view
        returns (bool);

    function setRuleV2(address token, RuleV2 calldata rule) external;
    function addRuleV2(address token, RuleV2 calldata rule) external;
    function removeRuleV2(address token, uint256 index) external;

    /// @dev The `*FromToken` entry points authenticate on `msg.sender` being the
    ///      token itself, which is why the token exposes wrappers rather than
    ///      letting an admin call the policy directly.
    function setRuleV2FromToken(RuleV2 calldata rule) external;
    function addRuleV2FromToken(RuleV2 calldata rule) external;
    function removeRuleV2FromToken(uint256 index) external;

    function getRulesV2(address token) external view returns (RuleV2[] memory);
}
