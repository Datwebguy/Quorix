import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  clientAddress: z.string(),
  title: z.string(),
  description: z.string(),
  budgetWei: z.string(), // represented in Wei
  deadlineTimestamp: z.number(), // Unix timestamp
  expectedProofHash: z.string().optional(),
});

export const SLAProposalSchema = z.object({
  taskId: z.string(),
  priceWei: z.string(),
  deliverables: z.array(z.string()),
  timelineDays: z.number(),
  escrowReleaseConditions: z.string(),
  arbitrationTerms: z.string(),
});

export const CounterProposalSchema = z.object({
  status: z.enum(['ACCEPTED', 'COUNTERED', 'DECLINED']),
  proposal: SLAProposalSchema.optional(),
  reason: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;
export type SLAProposal = z.infer<typeof SLAProposalSchema>;
export type CounterProposal = z.infer<typeof CounterProposalSchema>;
