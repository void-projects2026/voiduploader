import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const SessionContext = createContext(null);

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.api.getSession().then((res) => {
      setProfile(res.loggedIn ? res.profile : null);
      setLoading(false);
    });
  }, []);

  const login = useCallback(async (email, password) => {
    const result = await window.api.login(email, password);
    if (result.success) setProfile(result.profile);
    return result;
  }, []);

  const logout = useCallback(async () => {
    await window.api.logout();
    setProfile(null);
  }, []);

  return (
    <SessionContext.Provider value={{ profile, loading, login, logout }}>
      {children}
    </SessionContext.Provider>
  );
}
