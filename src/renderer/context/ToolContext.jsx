import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToolContext = createContext(null);

export function useTool() {
  return useContext(ToolContext);
}

// Download-tool state shared by the "التحميل" and "تحميلاتي" tabs: whether the
// Python tool is ready, setup progress, and the live download tasks.
export function ToolProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupLog, setSetupLog] = useState(null); // { step, message, pct }
  const [setupError, setSetupError] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [libraryTick, setLibraryTick] = useState(0);

  const refreshStatus = useCallback(() => window.api.toolStatus().then(setStatus), []);

  useEffect(() => {
    refreshStatus();
    window.api.listDownloads().then(setTasks);
    window.api.onDownloadsUpdated((t) => setTasks([...t]));
    window.api.onToolSetupProgress(setSetupLog);
    window.api.onLibraryChanged(() => setLibraryTick((n) => n + 1));
  }, [refreshStatus]);

  const setup = async (opts) => {
    setSetupBusy(true);
    setSetupError(null);
    setSetupLog({ step: 'python', message: 'جارِ البدء...' });
    const res = await window.api.toolSetup(opts);
    setSetupBusy(false);
    if (!res.success) setSetupError(res.error);
    await refreshStatus();
    return res;
  };

  return (
    <ToolContext.Provider value={{ status, refreshStatus, setup, setupBusy, setupLog, setupError, tasks, libraryTick }}>
      {children}
    </ToolContext.Provider>
  );
}
