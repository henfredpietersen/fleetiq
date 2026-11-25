export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string; details?: string[] }
  | { status: "success"; message?: string };

export const idle: ActionState = { status: "idle" };

export type Outcome<T = object> =
  | ({ ok: true } & T)
  | {
      ok: false;
      message: string;
      details?: string[];
      /** SQLSTATE / IN0xx / DM0xx of a database refusal (the offline queue classifies on it). */ code?: string;
    };
