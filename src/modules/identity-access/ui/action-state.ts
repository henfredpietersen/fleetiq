export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string; details?: string[] }
  | { status: "success"; message?: string };

export const idle: ActionState = { status: "idle" };
