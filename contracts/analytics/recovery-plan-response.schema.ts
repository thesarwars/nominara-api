import { z } from "zod";
import { taskSchema } from "../tasks/task-response.schema.js";

// NEW-C-6 — `POST /v1/displacements/{id}/recovery-plan` (STORY-057 AC6/7/8/9).
//
// The response is the plan's tasks, and a task is exactly the task Track B
// already puts on the wire: reusing `taskSchema` (not a copy) is what keeps the
// two from drifting. The route takes no body, so there is no request schema
// to declare `.strict()` on.
//
// The array is the plan as it stands after the call: tasks this call created
// plus any open task the same plan already made (a repeat call creates nothing
// new and returns the same tasks). An EMPTY array is a real answer: no seedable
// citation gap and no concept gap.
export const recoveryPlanResponseSchema = z.array(taskSchema);

export type RecoveryPlanResponse = z.infer<typeof recoveryPlanResponseSchema>;
