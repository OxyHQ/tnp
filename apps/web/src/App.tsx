import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import Register from "./pages/Register";
import Domains from "./pages/Domains";
import Dashboard from "./pages/Dashboard";
import ServiceNodes from "./pages/ServiceNodes";
import Network from "./pages/Network";
import Propose from "./pages/Propose";
import Install from "./pages/Install";
import DomainDetail from "./pages/DomainDetail";
import Park from "./pages/Park";
import Services from "./pages/Services";
import ServicesDomain from "./pages/ServicesDomain";
import { AuthBridge } from "./lib/auth";

export default function App() {
  return (
    <HelmetProvider>
    <AuthBridge />
    {/* One toaster for the app; pages report failed actions through `toast`. */}
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/register" element={<Register />} />
          <Route path="/domains" element={<Domains />} />
          <Route path="/d/:domain" element={<DomainDetail />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/service-nodes"
            element={
              <ProtectedRoute>
                <ServiceNodes />
              </ProtectedRoute>
            }
          />
          <Route path="/network" element={<Network />} />
          <Route path="/propose" element={<Propose />} />
          <Route path="/install" element={<Install />} />
          <Route path="/park/:domain" element={<Park />} />
          {/* Optional services area. Status and explanation are public; the
              page itself asks for a session before search and inventory. */}
          <Route path="/services" element={<Services />} />
          <Route
            path="/services/domains/:id"
            element={
              <ProtectedRoute>
                <ServicesDomain />
              </ProtectedRoute>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
    </HelmetProvider>
  );
}
