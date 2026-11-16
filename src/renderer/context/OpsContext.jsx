import React, { createContext, useContext, useEffect, useState } from 'react';

const OpsContext = createContext(null);

export function useOps() {
  return useContext(OpsContext);
}

// Operations are global (shown in the sidebar/tab regardless of which
// screen is active, and need to survive tab switches without re-fetching),
// so this lives above the router, fed by the same 'ops:updated' push the
// main process already emits every few seconds.
export function OpsProvider({ children }) {
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    window.api.listOps().then(setJobs);
    window.api.onOpsUpdated(setJobs);
  }, []);

  const retryHost = async (jobId, host) => {
    await window.api.retryHost({ jobId, host });
  };

  return <OpsContext.Provider value={{ jobs, retryHost }}>{children}</OpsContext.Provider>;
}
