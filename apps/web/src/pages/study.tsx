import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  type AssignmentRow,
  api,
  type DeliveryRow,
  type RandomizationList,
  type RandomizeResult,
} from "../api.js";
import { useStudy } from "../app.js";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  formatDateTime,
  inputClass,
  Modal,
  StatusBadge,
} from "../ui.js";

export function StudyPage() {
  const { study, permissions } = useStudy();
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-slate-900">{study.name}</h1>
        <span className="text-sm text-slate-500">
          EDC: {study.edcBaseUrl} · {study.edcStudyId}
          {study.enabled ? "" : " · disabled"}
        </span>
      </div>
      <ListsCard />
      {permissions.includes("subject.randomize") && <RandomizeCard />}
      <AssignmentsCard />
      <DeliveriesCard />
    </>
  );
}

function ListsCard() {
  const { study, permissions } = useStudy();
  const queryClient = useQueryClient();
  const lists = useQuery({
    queryKey: ["lists", study.id],
    queryFn: () => api<RandomizationList[]>(`/studies/${study.id}/lists`),
  });
  const [showImport, setShowImport] = useState(false);
  const [activating, setActivating] = useState<RandomizationList | null>(null);
  const canManage = permissions.includes("list.manage");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["lists", study.id] });

  return (
    <Card
      title="Randomization lists"
      actions={
        canManage ? <Button onClick={() => setShowImport(true)}>Import list</Button> : undefined
      }
    >
      {lists.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Version</th>
              <th className="pb-2">File</th>
              <th className="pb-2">Entries</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Activated</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lists.data.map((list) => (
              <tr key={list.id}>
                <td className="py-2">v{list.version}</td>
                <td className="py-2">
                  {list.filename}
                  <span className="ml-2 font-mono text-xs text-slate-400">
                    {list.sha256.slice(0, 8)}
                  </span>
                </td>
                <td className="py-2">{list.rowCount}</td>
                <td className="py-2">
                  <StatusBadge status={list.status} />
                </td>
                <td className="py-2 text-slate-500">
                  {list.status === "active"
                    ? `${formatDateTime(list.activatedAt)} — ${list.activationReason ?? ""}`
                    : "—"}
                </td>
                <td className="py-2 text-right">
                  {canManage && list.status === "draft" && (
                    <Button variant="secondary" onClick={() => setActivating(list)}>
                      Activate
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">
          No lists yet.{" "}
          {canManage
            ? "Import a statistician-generated CSV (seq,arm,stratum)."
            : "A list manager imports the statistician-generated list."}
        </p>
      )}
      {showImport && (
        <ImportModal
          onClose={() => {
            setShowImport(false);
            refresh();
          }}
        />
      )}
      {activating && (
        <ActivateModal
          list={activating}
          onClose={() => {
            setActivating(null);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { study } = useStudy();
  const [filename, setFilename] = useState("");
  const [csv, setCsv] = useState("");
  const importList = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/lists`, {
        method: "POST",
        body: JSON.stringify({ filename: filename || "list.csv", csv }),
      }),
    onSuccess: onClose,
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setCsv(await file.text());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    importList.mutate();
  };

  return (
    <Modal title="Import randomization list" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="CSV file" hint="Header seq,arm[,stratum]; generated outside this system.">
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </Field>
        <Field label="Content">
          <textarea
            className={`${inputClass} h-40 font-mono`}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"seq,arm,stratum\n1,Arm A,\n2,Arm B,"}
          />
        </Field>
        <ErrorNote message={importList.error ? importList.error.message : null} />
        <Button type="submit" disabled={importList.isPending || !csv}>
          {importList.isPending ? "Importing…" : "Import as draft"}
        </Button>
      </form>
    </Modal>
  );
}

function ActivateModal({ list, onClose }: { list: RandomizationList; onClose: () => void }) {
  const { study } = useStudy();
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const activate = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/lists/${list.id}/activate`, {
        method: "POST",
        body: JSON.stringify({ password, reason }),
      }),
    onSuccess: onClose,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    activate.mutate();
  };

  return (
    <Modal title={`Activate list v${list.version}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Activation retires any currently active list and opens this one for allocation. Re-enter
          your password to sign this action; both the reason and your identity are recorded in the
          audit trail.
        </p>
        <Field label="Reason">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <ErrorNote message={activate.error ? activate.error.message : null} />
        <Button type="submit" disabled={activate.isPending || !password || !reason}>
          {activate.isPending ? "Activating…" : "Activate"}
        </Button>
      </form>
    </Modal>
  );
}

function RandomizeCard() {
  const { study } = useStudy();
  const queryClient = useQueryClient();
  const [subjectKey, setSubjectKey] = useState("");
  const [stratum, setStratum] = useState("");
  const [result, setResult] = useState<RandomizeResult | null>(null);

  const randomize = useMutation({
    mutationFn: () =>
      api<RandomizeResult>(
        `/studies/${study.id}/subjects/${encodeURIComponent(subjectKey)}/randomize`,
        {
          method: "POST",
          body: JSON.stringify(stratum ? { stratum } : {}),
        },
      ),
    onSuccess: (data) => {
      setResult(data);
      setSubjectKey("");
      queryClient.invalidateQueries({ queryKey: ["assignments", study.id] });
      queryClient.invalidateQueries({ queryKey: ["deliveries", study.id] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    randomize.mutate();
  };

  return (
    <Card title="Randomize a subject">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
        <div className="grow">
          <Field label="Subject key" hint="The EDC subject identifier — no PHI.">
            <input
              className={inputClass}
              value={subjectKey}
              onChange={(e) => setSubjectKey(e.target.value)}
            />
          </Field>
        </div>
        <div className="grow">
          <Field label="Stratum" hint="Leave empty for an unstratified list.">
            <input
              className={inputClass}
              value={stratum}
              onChange={(e) => setStratum(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={randomize.isPending || !subjectKey}>
          {randomize.isPending ? "Randomizing…" : "Randomize"}
        </Button>
      </form>
      <div className="mt-4 space-y-2">
        <ErrorNote message={randomize.error ? randomize.error.message : null} />
        {result && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {result.subjectKey} randomized. Delivery to EDC: {result.delivery.outcome}
            {result.delivery.reason ? ` (${result.delivery.reason})` : ""}. You remain blinded; the
            arm was sent only to the EDC.
          </p>
        )}
      </div>
    </Card>
  );
}

function AssignmentsCard() {
  const { study } = useStudy();
  const assignments = useQuery({
    queryKey: ["assignments", study.id],
    queryFn: () => api<AssignmentRow[]>(`/studies/${study.id}/assignments`),
  });

  return (
    <Card title="Assignments">
      {assignments.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Subject</th>
              <th className="pb-2">Randomization ID</th>
              <th className="pb-2">Randomized</th>
              <th className="pb-2">Last delivery</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {assignments.data.map((row) => (
              <tr key={row.id}>
                <td className="py-2">{row.subjectKey}</td>
                <td className="py-2 font-mono text-xs">{row.randomizationId}</td>
                <td className="py-2 text-slate-500">{formatDateTime(row.createdAt)}</td>
                <td className="py-2">
                  {row.lastDelivery ? <StatusBadge status={row.lastDelivery.outcome} /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">No subjects randomized yet.</p>
      )}
    </Card>
  );
}

function DeliveriesCard() {
  const { study, permissions } = useStudy();
  const queryClient = useQueryClient();
  const deliveries = useQuery({
    queryKey: ["deliveries", study.id],
    queryFn: () => api<DeliveryRow[]>(`/studies/${study.id}/deliveries`),
  });
  const redeliver = useMutation({
    mutationFn: (assignmentId: string) =>
      api(`/studies/${study.id}/assignments/${assignmentId}/redeliver`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deliveries", study.id] }),
  });
  const canRedeliver = permissions.includes("delivery.manage");

  return (
    <Card title="Transfer log">
      {deliveries.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Subject</th>
              <th className="pb-2">Arm</th>
              <th className="pb-2">Outcome</th>
              <th className="pb-2">HTTP</th>
              <th className="pb-2">When</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {deliveries.data.map((row) => (
              <tr key={row.id}>
                <td className="py-2">{row.payload.subjectKey}</td>
                <td className="py-2 font-mono text-xs">{row.payload.arm}</td>
                <td className="py-2">
                  <StatusBadge status={row.outcome} />
                  {row.reason && <span className="ml-2 text-xs text-slate-500">{row.reason}</span>}
                </td>
                <td className="py-2 text-slate-500">{row.httpStatus ?? "—"}</td>
                <td className="py-2 text-slate-500">{formatDateTime(row.createdAt)}</td>
                <td className="py-2 text-right">
                  {canRedeliver && (row.outcome === "error" || row.outcome === "rejected") && (
                    <Button
                      variant="secondary"
                      onClick={() => redeliver.mutate(row.assignmentId)}
                      disabled={redeliver.isPending}
                    >
                      Re-send
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">No deliveries yet.</p>
      )}
      <p className="mt-3 text-xs text-slate-400">
        This log reconciles against the EDC's rtsm_events transfer record. Arms are masked unless
        you hold unblinded access, and unblinded views are audited.
      </p>
    </Card>
  );
}
