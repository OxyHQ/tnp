import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import Register from "./pages/Register";
import Domains from "./pages/Domains";
import Dashboard from "./pages/Dashboard";
import Propose from "./pages/Propose";
import Install from "./pages/Install";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/explore" element={<Explore />} />
            <Route path="/register" element={<Register />} />
            <Route path="/domains" element={<Domains />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route path="/propose" element={<Propose />} />
            <Route path="/install" element={<Install />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
