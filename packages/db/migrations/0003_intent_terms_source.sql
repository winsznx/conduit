-- Make an unknown intent look unknown.
--
-- ## What was wrong
--
-- Every column in `conduit.intents` is `NOT NULL`, and the bootstrap loader
-- derives its rows from verification artifacts — which record what the verifier
-- proved about a settlement, and carry no intent terms at all. The loader had
-- nowhere to put "I do not know", so it wrote the only values the constraints
-- accept:
--
-- ```text
--   intent          cash_amount  cash_payer  asset_amount
--   0x30aa1b738cab            0          ''             0
--   0x940f1c152189            0          ''             0
--   0xf5d9093fb458            0          ''             0
-- ```
--
-- Read back, those are three zero-value trades between unnamed parties. They
-- are nothing of the sort: two of them moved 25.000000 A-Token against 500000
-- units of the bond. A projection that renders a real trade as a zero is worse
-- than one that renders nothing, because a zero is a number and a reader will
-- believe it.
--
-- ## Why a column rather than nullable terms
--
-- Dropping `NOT NULL` across nineteen columns would let the loader write NULLs,
-- and NULL does read as "unknown". It also permanently weakens the table for
-- the indexer, which writes intents from signed payloads where every field is
-- present and required — the constraint is correct for the writer that matters,
-- and the bootstrap is the exception.
--
-- `terms_source` records which writer produced the row, so a consumer can tell
-- a proven intent from a placeholder without inspecting the values and guessing
-- whether a zero was real. Existing rows default to `unknown`, which is exactly
-- what they are; the loader upgrades a row to `artifact` when it has recovered
-- the terms from the run that produced the settlement.

ALTER TABLE conduit.intents
  ADD COLUMN terms_source TEXT NOT NULL DEFAULT 'unknown';

-- `signed` is unused today and is named here rather than later so the indexer
-- does not have to widen the constraint to start writing real signed intents.
ALTER TABLE conduit.intents
  ADD CONSTRAINT intents_terms_source_check
  CHECK (terms_source IN ('unknown', 'artifact', 'signed'));

COMMENT ON COLUMN conduit.intents.terms_source IS
  'Provenance of the term columns. unknown = placeholder, the terms were not '
  'recoverable and every term column is a zero value that must not be read as '
  'data. artifact = recovered from the run artifact that produced the '
  'settlement. signed = taken from a signed intent payload.';
