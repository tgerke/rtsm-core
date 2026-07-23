import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, api, type Me, type Study } from "./api.js";

interface StudyContextValue {
  me: Me;
  study: Study;
  studies: Study[];
  permissions: string[];
  setStudyId: (id: string) => void;
}

const StudyContext = createContext<StudyContextValue | null>(null);

export function useStudy(): StudyContextValue {
  const value = useContext(StudyContext);
  if (!value) throw new Error("useStudy outside AppLayout");
  return value;
}

export function AppLayout() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), retry: false });
  const studies = useQuery({
    queryKey: ["studies"],
    queryFn: () => api<Study[]>("/studies"),
    enabled: me.isSuccess,
  });
  const [studyId, setStudyId] = useState<string | null>(localStorage.getItem("rtsm.studyId"));

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      navigate({ to: "/login" });
    }
  }, [me.error, navigate]);

  const study = studies.data?.find((s) => s.id === studyId) ?? studies.data?.[0] ?? null;

  const permissions = useQuery({
    queryKey: ["permissions", study?.id],
    queryFn: () => api<string[]>(`/studies/${study?.id}/permissions`),
    enabled: study !== null,
  });

  if (me.isLoading || studies.isLoading) {
    return <div className="p-10 text-center text-slate-500">Loading…</div>;
  }
  if (!me.data) return null;
  if (!study) {
    return (
      <div className="p-10 text-center text-slate-500">
        No studies visible to your account. Ask an administrator for a role grant.
      </div>
    );
  }

  const select = (id: string) => {
    localStorage.setItem("rtsm.studyId", id);
    setStudyId(id);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST", body: "{}" });
    navigate({ to: "/login" });
  };

  return (
    <StudyContext.Provider
      value={{
        me: me.data,
        study,
        studies: studies.data ?? [],
        permissions: permissions.data ?? [],
        setStudyId: select,
      }}
    >
      <div className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <div className="flex items-center gap-4">
              <span className="text-lg font-bold tracking-tight text-indigo-700">rtsm-core</span>
              <select
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={study.id}
                onChange={(e) => select(e.target.value)}
              >
                {(studies.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span>{me.data.fullName}</span>
              <button
                type="button"
                onClick={logout}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 hover:bg-slate-50"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </StudyContext.Provider>
  );
}
