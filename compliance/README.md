# Compliance Pack

Working artifacts for taking the platform from "HIPAA patterns demonstrated honestly" to an
auditable SOC 2 / HIPAA posture. Nothing here is a compliance *claim* — it is the
control inventory, the gap list, and the policy set an auditor or a covered entity's
security review will ask for.

| Document | What it answers |
|---|---|
| [soc2-control-mapping.md](soc2-control-mapping.md) | Which SOC 2 Trust Services Criteria are already met by code, which are gaps, and where each control lives |
| [baa-readiness.md](baa-readiness.md) | What must be true before the platform vendor can sign a BAA and handle real PHI — including the LLM-provider problem |
| [policies/access-control-policy.md](policies/access-control-policy.md) | Who can access what, how access is granted/revoked, enforced by which code |
| [policies/incident-response-plan.md](policies/incident-response-plan.md) | What happens when something breaks or leaks, incl. HIPAA breach-notification clocks |
| [policies/data-retention-policy.md](policies/data-retention-policy.md) | How long each data class lives and how it dies |
| [policies/vendor-management-policy.md](policies/vendor-management-policy.md) | Subprocessor inventory and BAA status per vendor |

## Ground rules

1. **Controls live in code first.** Every claim in the mapping cites a file. If the code
   moves, update the citation — an unverifiable control is a finding.
2. **Synthetic data only until baa-readiness.md is green.** The platform must not touch
   real PHI while any BLOCKER row in that document is open.
3. **Policies are versioned here, in git.** Approval = merge to `main`; the git history
   is the change record an auditor sees.
