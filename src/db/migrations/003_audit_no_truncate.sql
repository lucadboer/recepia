-- Close the TRUNCATE gap: row-level triggers (002) do not fire on TRUNCATE.
-- Add a statement-level BEFORE TRUNCATE trigger so audit_log is fully append-only.
-- (Tests clean up by temporarily disabling user triggers as the table owner.)

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutations();
