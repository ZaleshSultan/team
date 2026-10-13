import { SyntheticGuardError } from './synthetic-guard.js';

export interface SyntheticConstraint {
  name: string;
  expression: string;
  validated: boolean;
}

/** Only the unchanged M1 positive-ID CHECK may be temporarily unvalidated. */
export function requireSyntheticConstraint(rows: SyntheticConstraint[], requireValidated: boolean): SyntheticConstraint {
  if (rows.length !== 1) throw new SyntheticGuardError('SYNTHETIC_SCHEMA_UNSUPPORTED');
  const constraint = rows[0]!;
  // Accept PostgreSQL's redundant parentheses/spacing and its quoted identifier,
  // but no other column, literal, operator, or broadened reserved-range CHECK.
  const expression = constraint.expression.replace(/"telegram_id"/g, 'telegram_id').replace(/[\s()]/g, '');
  if (constraint.name !== 'users_telegram_id_positive' || expression !== 'telegram_id>0' || typeof constraint.validated !== 'boolean') {
    throw new SyntheticGuardError('SYNTHETIC_SCHEMA_UNSUPPORTED');
  }
  if (requireValidated && !constraint.validated) throw new SyntheticGuardError('SYNTHETIC_SCHEMA_VALIDATION_REQUIRED');
  return constraint;
}
