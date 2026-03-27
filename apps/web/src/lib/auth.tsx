import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useAuth as useOxyAuth } from "@oxyhq/auth";
import { apiFetch, setToken, clearToken, getStoredToken } from "./api";

interface TNPUser {
  id: string;
  oxyUserId: string;
}

interface AuthContextValue {
  user: TNPUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user: oxyUser, isAuthenticated: oxyAuthenticated, signIn, signOut } = useOxyAuth();
  const [token, setTokenState] = useState<string | null>(getStoredToken);
  const [user, setUser] = useState<TNPUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // When Oxy auth state changes, exchange for a TNP JWT
  useEffect(() => {
    if (!oxyAuthenticated || !oxyUser?._id) {
      setUser(null);
      setTokenState(null);
      clearToken();
      return;
    }

    let ignore = false;
    setIsLoading(true);

    apiFetch<{ token: string; user: TNPUser }>("/auth/oxy", {
      method: "POST",
      body: JSON.stringify({ oxyUserId: oxyUser._id }),
    })
      .then((res) => {
        if (ignore) return;
        setToken(res.token);
        setTokenState(res.token);
        setUser(res.user);
      })
      .catch(() => {
        if (!ignore) {
          clearToken();
          setTokenState(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [oxyAuthenticated, oxyUser?._id]);

  const login = useCallback(() => {
    signIn();
  }, [signIn]);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
    signOut();
  }, [signOut]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!token && !!user,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
