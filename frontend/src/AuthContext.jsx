import { createContext, useContext, useMemo, useState } from 'react';
import api from './api';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(() => { try { return JSON.parse(localStorage.getItem('payroll_admin')); } catch { return null; } });
  const signIn = async (credentials, mode = 'login') => {
    const { data } = await api.post(`/auth/${mode}`, credentials);
    localStorage.setItem('payroll_token', data.token); localStorage.setItem('payroll_admin', JSON.stringify(data.admin)); setAdmin(data.admin);
  };
  const signOut = () => { localStorage.removeItem('payroll_token'); localStorage.removeItem('payroll_admin'); setAdmin(null); };
  const value = useMemo(() => ({ admin, signIn, signOut, setAdmin }), [admin]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
