// Hand-rolled stand-ins for the Supabase clients, so the server steps can be unit-tested without a database.
// (Real behaviour — RLS, storage policies, SQL functions — is covered by the pgTAP and integration tests.)
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Err = { message: string; code?: string; statusCode?: string } | null;
export type Call = { fn: string; args: unknown[] };

export type FakeOptions = {
  user?: { id: string } | null;
  slot?: Record<string, unknown> | null;
  rpc?: Record<
    string,
    (args: Record<string, unknown>) => { data?: unknown; error?: Err }
  >;
  objects?: Record<string, Uint8Array>;
  objectSize?: number; // overrides what info() reports
  signedUpload?: { data?: { signedUrl: string; token: string }; error?: Err };
  signedUrl?: { data?: { signedUrl: string }; error?: Err };
  removeError?: Err;
};

export function fakeClient(o: FakeOptions = {}) {
  const calls: Call[] = [];
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const objects = { ...(o.objects ?? {}) };
  const storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string) => {
        rec("createSignedUploadUrl", bucket, path);
        return (
          o.signedUpload ?? {
            data: {
              signedUrl: `https://signed.example/up/${path}`,
              token: "tok",
            },
            error: null,
          }
        );
      },
      createSignedUrl: async (path: string, seconds: number) => {
        rec("createSignedUrl", bucket, path, seconds);
        return (
          o.signedUrl ?? {
            data: { signedUrl: `https://signed.example/get/${path}` },
            error: null,
          }
        );
      },
      info: async (path: string) => {
        rec("info", bucket, path);
        const obj = objects[path];
        if (!obj)
          return {
            data: null,
            error: { message: "Object not found", statusCode: "404" },
          };
        return { data: { size: o.objectSize ?? obj.length }, error: null };
      },
      download: async (path: string) => {
        rec("download", bucket, path);
        const obj = objects[path];
        return obj
          ? { data: new Blob([obj as BlobPart]), error: null }
          : { data: null, error: { message: "Object not found" } };
      },
      upload: async (path: string, body: Uint8Array, opts: unknown) => {
        rec("upload", bucket, path, body, opts);
        objects[path] = body;
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        rec("remove", bucket, paths);
        if (o.removeError) return { data: null, error: o.removeError };
        for (const p of paths) delete objects[p];
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  };
  const client = {
    auth: {
      getUser: async () => {
        rec("getUser");
        return o.user === null
          ? { data: { user: null }, error: { message: "no session" } }
          : {
              data: {
                user: o.user ?? { id: "11111111-1111-4111-8111-111111111111" },
              },
              error: null,
            };
      },
    },
    from: (table: string) => {
      const q = {
        select: (...a: unknown[]) => (rec("select", table, ...a), q),
        eq: (...a: unknown[]) => (rec("eq", table, ...a), q),
        in: async (...a: unknown[]) => {
          rec("in", table, ...a);
          const h = o.rpc?.[`from:${table}`];
          return h
            ? { data: h({}).data, error: h({}).error ?? null }
            : { data: [], error: null };
        },
        maybeSingle: async () => ({ data: o.slot ?? null, error: null }),
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rec(`rpc:${name}`, args);
      const h = o.rpc?.[name];
      if (!h)
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      const r = h(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
    storage,
  };
  return {
    client: client as unknown as SupabaseClient<Database>,
    calls,
    objects,
  };
}

export const names = (calls: Call[]) => calls.map((c) => c.fn);
export const called = (calls: Call[], fn: string) =>
  calls.filter((c) => c.fn === fn);
