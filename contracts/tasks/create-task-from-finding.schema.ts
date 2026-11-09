import { z } from "zod";

// POST /v1/aux-findings/{id}/create-task — manual promotion of a finding to a task (api-specification.md "AUX", STORY-194).
//
// The finding names everything the task needs (title, URL, rule, project), so the body carries nothing. It is still a strict
// object, so a field a client believes it can set (a title, a kind, an impact) is a 400 rather than a silent drop. The
// response is the task, `taskSchema`; it is the existing task's own row when an open task already has the finding's fingerprint.
export const createTaskFromFindingRequestSchema = z.object({}).strict();

export type CreateTaskFromFindingRequest = z.infer<typeof createTaskFromFindingRequestSchema>;
