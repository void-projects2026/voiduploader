import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ScheduleContext = createContext(null);

export function useSchedule() {
  return useContext(ScheduleContext);
}

// Scheduler tasks (pushed live from the main process) + the site's works with
// their missing episodes (loaded on demand: it's a few API calls).
export function ScheduleProvider({ children }) {
  const [tasks, setTasks] = useState([]);
  const [works, setWorks] = useState(null);
  const [worksLoading, setWorksLoading] = useState(false);
  const [worksError, setWorksError] = useState(null);

  useEffect(() => {
    window.api.schedList().then(setTasks);
    window.api.onSchedUpdated((t) => setTasks([...t]));
  }, []);

  const refreshWorks = useCallback(async () => {
    setWorksLoading(true);
    setWorksError(null);
    const res = await window.api.schedWorks();
    setWorksLoading(false);
    if (res.success) setWorks(res.works);
    else setWorksError(res.error || 'فشل جلب الأعمال');
    return res;
  }, []);

  return (
    <ScheduleContext.Provider value={{ tasks, works, worksLoading, worksError, refreshWorks }}>
      {children}
    </ScheduleContext.Provider>
  );
}
