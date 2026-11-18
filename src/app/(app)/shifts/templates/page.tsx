import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  getShiftAccess,
  listTemplates,
} from "@/modules/shifts-allocations/server/queries";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";
import {
  ArchiveTemplateForm,
  CreateTemplateForm,
  EditTemplateForm,
  TemplateTimes,
} from "@/modules/shifts-allocations/ui/template-forms";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const access = await getShiftAccess(db);
  if (!access.ok)
    return (
      <Alert variant="destructive">
        Shift templates could not be loaded. Please refresh the page.
      </Alert>
    );
  const viewable = access.branches.filter((b) => b.canView);
  if (viewable.length === 0)
    return (
      <Alert>
        You do not have access to shift templates. They are visible to people
        who manage allocations or view reports.
      </Alert>
    );
  const branch = viewable.find((b) => b.id === first(sp.branch)) ?? viewable[0];
  const showArchived = first(sp.archived) === "1";
  const res = await listTemplates(db, branch.id, showArchived);
  if (!res.ok)
    return (
      <Alert variant="destructive">
        The templates could not be loaded. Please refresh the page.
      </Alert>
    );
  const templates = res.templates;

  return (
    <>
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Choose branch"
      >
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select id="branch" name="branch" defaultValue={branch.id}>
            {viewable.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="archived"
            value="1"
            defaultChecked={showArchived}
          />
          Show archived
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Templates at {branch.name}</CardTitle>
          <CardDescription>
            A template is a reusable start and end time. Editing or archiving
            one never changes shifts already created from it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {templates.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No shift templates at this branch yet.
              {branch.canManage ? " Create the first one below." : ""}
            </p>
          ) : (
            <ul className="flex flex-col gap-4" aria-label="Shift templates">
              {templates.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-col gap-3 rounded-md border p-4"
                  data-testid="template-row"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{t.name}</span>
                    <TemplateTimes start={t.start_time} end={t.end_time} />
                    {t.status === "archived" ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </div>
                  {branch.canManage && t.status === "active" ? (
                    <div className="flex flex-col gap-3">
                      <details>
                        <summary className="cursor-pointer text-sm underline">
                          Edit…
                        </summary>
                        <div className="mt-3">
                          <EditTemplateForm
                            templateId={t.id}
                            name={t.name}
                            start={t.start_time}
                            end={t.end_time}
                          />
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer text-sm underline">
                          Archive…
                        </summary>
                        <div className="mt-3 max-w-md">
                          <ArchiveTemplateForm templateId={t.id} />
                        </div>
                      </details>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {branch.canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>New template</CardTitle>
            <CardDescription>
              Names are unique per branch among active templates (not
              case-sensitive).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateTemplateForm branchId={branch.id} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-sm">
          You can view templates at this branch but not change them.
        </p>
      )}
    </>
  );
}

export default function TemplatesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Shift templates"
      description="Reusable shift times per branch. Archive a template instead of deleting it."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading templates…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
