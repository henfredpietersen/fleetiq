export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string; details?: string[] }
  | {
      status: "success";
      message?: string;
      /** A one-time secret (temporary PIN / password) for the issuer to read out. Never stored or logged. */
      revealed?: { label: string; value: string };
    };

export const idle: ActionState = { status: "idle" };
