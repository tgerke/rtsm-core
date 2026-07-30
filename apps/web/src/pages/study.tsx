import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  type AssignmentRow,
  api,
  type CodeBreakResult,
  type CodeBreakRow,
  type DeliveryRow,
  type DispenseResult,
  type DispenseRow,
  type KitRow,
  type KitTypeRow,
  type RandomizationList,
  type RandomizeResult,
  type Site,
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
      {permissions.includes("kit.dispense") && <DispenseCard />}
      {permissions.includes("subject.codebreak") && <CodeBreakCard />}
      <AssignmentsCard />
      <DispenseLogCard />
      {permissions.includes("audit.review") && <CodeBreakLogCard />}
      <DeliveriesCard />
      <KitsCard />
      {permissions.includes("kit.read_unblinded") && <KitTypesCard />}
      <SitesCard />
    </>
  );
}

function DispenseCard() {
  const { study } = useStudy();
  const queryClient = useQueryClient();
  const sites = useSites();
  const [subjectKey, setSubjectKey] = useState("");
  const [siteId, setSiteId] = useState("");
  const [result, setResult] = useState<DispenseResult | null>(null);
  const activeSites = (sites.data ?? []).filter((s) => s.status === "active");

  const dispense = useMutation({
    mutationFn: () =>
      api<DispenseResult>(
        `/studies/${study.id}/subjects/${encodeURIComponent(subjectKey)}/dispense`,
        { method: "POST", body: JSON.stringify({ siteId }) },
      ),
    onSuccess: (data) => {
      setResult(data);
      setSubjectKey("");
      queryClient.invalidateQueries({ queryKey: ["dispenses", study.id] });
      queryClient.invalidateQueries({ queryKey: ["kits", study.id] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    dispense.mutate();
  };

  return (
    <Card title="Dispense a kit">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
        <div className="grow">
          <Field label="Subject key" hint="Must already be randomized.">
            <input
              className={inputClass}
              value={subjectKey}
              onChange={(e) => setSubjectKey(e.target.value)}
            />
          </Field>
        </div>
        <div className="grow">
          <Field label="Site" hint="The kit comes from this site's inventory.">
            <select
              className={inputClass}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              <option value="">—</option>
              {activeSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" disabled={dispense.isPending || !subjectKey || !siteId}>
          {dispense.isPending ? "Dispensing…" : "Dispense"}
        </Button>
      </form>
      <div className="mt-4 space-y-2">
        <ErrorNote message={dispense.error ? dispense.error.message : null} />
        {result && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Dispense kit <span className="font-mono">{result.kitNumber}</span> (lot {result.lot},
            expires {result.expiresOn}) to {result.subjectKey}. The kit was matched to their
            assignment server-side; you remain blinded.
          </p>
        )}
      </div>
    </Card>
  );
}

function CodeBreakCard() {
  const { study } = useStudy();
  const queryClient = useQueryClient();
  const [subjectKey, setSubjectKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CodeBreakResult | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    setConfirming(true);
  };

  return (
    <Card title="Emergency code-break">
      <p className="text-sm text-slate-600">
        Unblinds one subject for an urgent safety decision. The act is permanently recorded — who,
        when, and why — and the study team can see that it happened.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-4">
        <div className="grow">
          <Field label="Subject key" hint="Must already be randomized.">
            <input
              className={inputClass}
              value={subjectKey}
              onChange={(e) => setSubjectKey(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={!subjectKey}>
          Break the blind…
        </Button>
      </form>
      {result && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {result.subjectKey} is assigned to <span className="font-semibold">{result.arm}</span>.
          This unblinding was recorded at {formatDateTime(result.createdAt)}.
        </p>
      )}
      {confirming && (
        <CodeBreakModal
          subjectKey={subjectKey}
          onClose={() => setConfirming(false)}
          onBroken={(data) => {
            setConfirming(false);
            setResult(data);
            setSubjectKey("");
            queryClient.invalidateQueries({ queryKey: ["codebreaks", study.id] });
          }}
        />
      )}
    </Card>
  );
}

function CodeBreakModal({
  subjectKey,
  onClose,
  onBroken,
}: {
  subjectKey: string;
  onClose: () => void;
  onBroken: (result: CodeBreakResult) => void;
}) {
  const { study } = useStudy();
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const breakBlind = useMutation({
    mutationFn: () =>
      api<CodeBreakResult>(
        `/studies/${study.id}/subjects/${encodeURIComponent(subjectKey)}/codebreak`,
        { method: "POST", body: JSON.stringify({ password, reason }) },
      ),
    onSuccess: onBroken,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    breakBlind.mutate();
  };

  return (
    <Modal title={`Break the blind for ${subjectKey}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          You are about to see this subject's arm. The unblinding cannot be undone or erased from
          the record. Re-enter your password to sign this action; the reason and your identity join
          the audit trail.
        </p>
        <Field label="Reason" hint="e.g. the safety event requiring the treatment to be known.">
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
        <ErrorNote message={breakBlind.error ? breakBlind.error.message : null} />
        <Button type="submit" disabled={breakBlind.isPending || !password || !reason}>
          {breakBlind.isPending ? "Unblinding…" : "Unblind this subject"}
        </Button>
      </form>
    </Modal>
  );
}

function CodeBreakLogCard() {
  const { study } = useStudy();
  const codebreaks = useQuery({
    queryKey: ["codebreaks", study.id],
    queryFn: () => api<CodeBreakRow[]>(`/studies/${study.id}/codebreaks`),
  });
  if (!codebreaks.data?.length) return null;

  return (
    <Card title="Code-break log">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th className="pb-2">Subject</th>
            <th className="pb-2">Reason</th>
            <th className="pb-2">By</th>
            <th className="pb-2">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {codebreaks.data.map((row) => (
            <tr key={row.id}>
              <td className="py-2">{row.subjectKey}</td>
              <td className="py-2 text-slate-500">{row.reason}</td>
              <td className="py-2 font-mono text-xs">{row.performedBy}</td>
              <td className="py-2 text-slate-500">{formatDateTime(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-400">
        Every emergency unblinding, without the arm — the record of the break is visible; what was
        seen stays with the person who broke it.
      </p>
    </Card>
  );
}

function DispenseLogCard() {
  const { study } = useStudy();
  const dispenses = useQuery({
    queryKey: ["dispenses", study.id],
    queryFn: () => api<DispenseRow[]>(`/studies/${study.id}/dispenses`),
  });
  if (!dispenses.data?.length) return null;

  return (
    <Card title="Dispense log">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th className="pb-2">Subject</th>
            <th className="pb-2">Kit</th>
            <th className="pb-2">Site</th>
            <th className="pb-2">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {dispenses.data.map((row) => (
            <tr key={row.id}>
              <td className="py-2">{row.subjectKey}</td>
              <td className="py-2 font-mono text-xs">{row.kitNumber}</td>
              <td className="py-2 font-mono text-xs">{row.siteCode}</td>
              <td className="py-2 text-slate-500">{formatDateTime(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function KitsCard() {
  const { study, permissions } = useStudy();
  const queryClient = useQueryClient();
  // The unblinded listing adds the kit-to-arm join; every read of it is
  // logged server-side.
  const unblinded = permissions.includes("kit.read_unblinded");
  const kits = useQuery({
    queryKey: ["kits", study.id, unblinded],
    queryFn: () => api<KitRow[]>(`/studies/${study.id}/kits${unblinded ? "/unblinded" : ""}`),
  });
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<KitRow | null>(null);
  const canManage = permissions.includes("kit.manage");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kits", study.id] });

  return (
    <Card
      title="Kit inventory"
      actions={
        canManage ? <Button onClick={() => setShowImport(true)}>Import shipment</Button> : undefined
      }
    >
      {kits.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Kit</th>
              {unblinded && <th className="pb-2">Type</th>}
              {unblinded && <th className="pb-2">Arm</th>}
              <th className="pb-2">Lot</th>
              <th className="pb-2">Expires</th>
              <th className="pb-2">Site</th>
              <th className="pb-2">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {kits.data.map((kit) => (
              <tr key={kit.id}>
                <td className="py-2 font-mono text-xs">{kit.kitNumber}</td>
                {unblinded && <td className="py-2 font-mono text-xs">{kit.kitTypeCode}</td>}
                {unblinded && <td className="py-2">{kit.arm}</td>}
                <td className="py-2">{kit.lot}</td>
                <td className="py-2 text-slate-500">{kit.expiresOn}</td>
                <td className="py-2 font-mono text-xs">{kit.siteCode ?? "—"}</td>
                <td className="py-2">
                  <StatusBadge status={kit.status} />
                  {kit.statusReason && (
                    <span className="ml-2 text-xs text-slate-500">{kit.statusReason}</span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {canManage && kit.status !== "dispensed" && (
                    <Button variant="secondary" onClick={() => setEditing(kit)}>
                      Update
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">
          No kits yet.{" "}
          {canManage
            ? "Define kit types, then import a shipment CSV (kit_number,kit_type,lot,expiry)."
            : "A pharmacist imports and manages the kit inventory. Kit types stay hidden from blinded users."}
        </p>
      )}
      {showImport && (
        <ImportKitsModal
          onClose={() => {
            setShowImport(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <UpdateKitModal
          kit={editing}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function ImportKitsModal({ onClose }: { onClose: () => void }) {
  const { study } = useStudy();
  const sites = useSites();
  const [csv, setCsv] = useState("");
  const [siteId, setSiteId] = useState("");
  const importKits = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/kits`, {
        method: "POST",
        body: JSON.stringify({ csv, ...(siteId ? { siteId } : {}) }),
      }),
    onSuccess: onClose,
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsv(await file.text());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    importKits.mutate();
  };

  return (
    <Modal title="Import kit shipment" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="CSV file" hint="Header kit_number,kit_type,lot,expiry (expiry YYYY-MM-DD).">
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
            placeholder={"kit_number,kit_type,lot,expiry\nK-0001,KT-A,LOT-1,2027-01-31"}
          />
        </Field>
        <Field label="Ship to site" hint="Optional; kits can also be transferred later.">
          <select className={inputClass} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">— not yet shipped —</option>
            {(sites.data ?? [])
              .filter((s) => s.status === "active")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
          </select>
        </Field>
        <ErrorNote message={importKits.error ? importKits.error.message : null} />
        <Button type="submit" disabled={importKits.isPending || !csv}>
          {importKits.isPending ? "Importing…" : "Import"}
        </Button>
      </form>
    </Modal>
  );
}

function UpdateKitModal({ kit, onClose }: { kit: KitRow; onClose: () => void }) {
  const { study } = useStudy();
  const sites = useSites();
  const [status, setStatus] = useState("");
  const [siteId, setSiteId] = useState("");
  const [reason, setReason] = useState("");
  const update = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/kits/${kit.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...(status ? { status } : {}),
          ...(siteId ? { siteId } : {}),
          reason,
        }),
      }),
    onSuccess: onClose,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate();
  };

  return (
    <Modal title={`Update kit ${kit.kitNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Status" hint="Leave unchanged for a site transfer only.">
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">— unchanged ({kit.status}) —</option>
            <option value="available">available</option>
            <option value="quarantined">quarantined</option>
            <option value="damaged">damaged</option>
          </select>
        </Field>
        <Field label="Transfer to site">
          <select className={inputClass} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">— unchanged ({kit.siteCode ?? "not shipped"}) —</option>
            {(sites.data ?? [])
              .filter((s) => s.status === "active")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Reason" hint="Recorded on the kit and in the audit trail.">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorNote message={update.error ? update.error.message : null} />
        <Button type="submit" disabled={update.isPending || !reason || (!status && !siteId)}>
          {update.isPending ? "Updating…" : "Update kit"}
        </Button>
      </form>
    </Modal>
  );
}

function KitTypesCard() {
  const { study } = useStudy();
  const queryClient = useQueryClient();
  const kitTypes = useQuery({
    queryKey: ["kit-types", study.id],
    queryFn: () => api<KitTypeRow[]>(`/studies/${study.id}/kit-types`),
  });
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Card
      title="Kit types (unblinded)"
      actions={<Button onClick={() => setShowCreate(true)}>Add kit type</Button>}
    >
      {kitTypes.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Code</th>
              <th className="pb-2">Arm</th>
              <th className="pb-2">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {kitTypes.data.map((t) => (
              <tr key={t.id}>
                <td className="py-2 font-mono text-xs">{t.code}</td>
                <td className="py-2">{t.arm}</td>
                <td className="py-2 text-slate-500">{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">
          No kit types yet. Define the kit-to-arm map before importing kits.
        </p>
      )}
      <p className="mt-3 text-xs text-slate-400">
        This view is unblinded and every read of it is logged to the audit trail.
      </p>
      {showCreate && (
        <CreateKitTypeModal
          onClose={() => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: ["kit-types", study.id] });
          }}
        />
      )}
    </Card>
  );
}

function CreateKitTypeModal({ onClose }: { onClose: () => void }) {
  const { study } = useStudy();
  const [code, setCode] = useState("");
  const [arm, setArm] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/kit-types`, {
        method: "POST",
        body: JSON.stringify({ code, arm, ...(description ? { description } : {}) }),
      }),
    onSuccess: onClose,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Modal title="Add kit type" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          The code appears on physical kits and must not hint at the arm — blinded staff see kit
          numbers only, but the code is your unblinded handle for this type.
        </p>
        <Field label="Code" hint="e.g. KT-A; unique in this study.">
          <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Arm" hint="Must match the arm strings in the randomization list.">
          <input className={inputClass} value={arm} onChange={(e) => setArm(e.target.value)} />
        </Field>
        <Field label="Description">
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <ErrorNote message={create.error ? create.error.message : null} />
        <Button type="submit" disabled={create.isPending || !code || !arm}>
          {create.isPending ? "Adding…" : "Add kit type"}
        </Button>
      </form>
    </Modal>
  );
}

function useSites() {
  const { study } = useStudy();
  return useQuery({
    queryKey: ["sites", study.id],
    queryFn: () => api<Site[]>(`/studies/${study.id}/sites`),
  });
}

function SitesCard() {
  const { study, me, permissions } = useStudy();
  const queryClient = useQueryClient();
  const sites = useSites();
  const [showCreate, setShowCreate] = useState(false);
  const canManage = permissions.includes("site.manage") || me.isSystemAdmin;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sites", study.id] });

  const close = useMutation({
    mutationFn: (siteId: string) =>
      api(`/studies/${study.id}/sites/${siteId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "closed" }),
      }),
    onSuccess: refresh,
  });

  return (
    <Card
      title="Sites"
      actions={
        canManage ? <Button onClick={() => setShowCreate(true)}>Add site</Button> : undefined
      }
    >
      {sites.data?.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="pb-2">Code</th>
              <th className="pb-2">Name</th>
              <th className="pb-2">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sites.data.map((site) => (
              <tr key={site.id}>
                <td className="py-2 font-mono text-xs">{site.code}</td>
                <td className="py-2">{site.name}</td>
                <td className="py-2">
                  <StatusBadge status={site.status} />
                </td>
                <td className="py-2 text-right">
                  {canManage && site.status === "active" && (
                    <Button
                      variant="secondary"
                      onClick={() => close.mutate(site.id)}
                      disabled={close.isPending}
                    >
                      Close
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-slate-500">
          No sites yet.{" "}
          {canManage
            ? "Add the investigational sites to enable site-level randomization and, next, kit inventory."
            : "An administrator sets up the study's sites."}
        </p>
      )}
      <ErrorNote message={close.error ? close.error.message : null} />
      {showCreate && (
        <CreateSiteModal
          onClose={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function CreateSiteModal({ onClose }: { onClose: () => void }) {
  const { study } = useStudy();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api(`/studies/${study.id}/sites`, {
        method: "POST",
        body: JSON.stringify({ code, name }),
      }),
    onSuccess: onClose,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Modal title="Add site" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Code" hint="Short site identifier, unique in this study (e.g. SITE-001).">
          <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorNote message={create.error ? create.error.message : null} />
        <Button type="submit" disabled={create.isPending || !code || !name}>
          {create.isPending ? "Adding…" : "Add site"}
        </Button>
      </form>
    </Modal>
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
  const sites = useSites();
  const [subjectKey, setSubjectKey] = useState("");
  const [stratum, setStratum] = useState("");
  const [siteId, setSiteId] = useState("");
  const [result, setResult] = useState<RandomizeResult | null>(null);
  const activeSites = (sites.data ?? []).filter((s) => s.status === "active");

  const randomize = useMutation({
    mutationFn: () =>
      api<RandomizeResult>(
        `/studies/${study.id}/subjects/${encodeURIComponent(subjectKey)}/randomize`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(stratum ? { stratum } : {}),
            ...(siteId ? { siteId } : {}),
          }),
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
        {activeSites.length > 0 && (
          <div className="grow">
            <Field label="Site" hint="Required if your access is site-scoped.">
              <select
                className={inputClass}
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              >
                <option value="">—</option>
                {activeSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
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
              <th className="pb-2">Site</th>
              <th className="pb-2">Randomization ID</th>
              <th className="pb-2">Randomized</th>
              <th className="pb-2">Last delivery</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {assignments.data.map((row) => (
              <tr key={row.id}>
                <td className="py-2">{row.subjectKey}</td>
                <td className="py-2 font-mono text-xs">{row.siteCode ?? "—"}</td>
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
