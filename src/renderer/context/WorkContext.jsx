import React, { createContext, useContext, useState } from 'react';

const WorkContext = createContext(null);

export function useWork() {
  return useContext(WorkContext);
}

// The currently-selected anime work to upload against - set either by
// searching an existing work (Upload tab) or by finishing an AniList
// creation (Anime tab), so both flows funnel into the same place.
export function WorkProvider({ children }) {
  const [selectedWork, setSelectedWork] = useState(null); // { id, title }
  return <WorkContext.Provider value={{ selectedWork, setSelectedWork }}>{children}</WorkContext.Provider>;
}
