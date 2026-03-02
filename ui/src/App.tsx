import {
  Activity,
  BarChart3,
  Grid3X3,
  LayoutDashboard,
  Menu,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Link,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";

const Sessions = lazy(() =>
  import("@/pages/Sessions").then((m) => ({ default: m.Sessions })),
);
const Metrics = lazy(() =>
  import("@/pages/Metrics").then((m) => ({ default: m.Metrics })),
);
const SearchResults = lazy(() =>
  import("@/pages/SearchResults").then((m) => ({ default: m.SearchResults })),
);
const AI = lazy(() => import("@/pages/AI").then((m) => ({ default: m.AI })));
const Dashboard = lazy(() =>
  import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const TimelinePanel = lazy(() =>
  import("@/components/TimelinePanel").then((m) => ({
    default: m.TimelinePanel,
  })),
);
const EventDetailsPanel = lazy(() =>
  import("@/components/EventDetailsPanel").then((m) => ({
    default: m.EventDetailsPanel,
  })),
);

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchValue =
    location.pathname === "/search"
      ? new URLSearchParams(location.search).get("q") || ""
      : "";

  // Close mobile sidebar on navigation
  const currentPath = location.pathname;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on path change
  useEffect(() => {
    setMobileOpen(false);
  }, [currentPath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("globalSearch")?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navItems = useMemo(
    () => [
      {
        to: "/",
        label: "Sessions",
        icon: LayoutDashboard,
        active:
          location.pathname.startsWith("/sessions") ||
          location.pathname === "/",
      },
      {
        to: "/dashboard",
        label: "Dashboard",
        icon: Grid3X3,
        active: location.pathname === "/dashboard",
      },
      {
        to: "/metrics",
        label: "Metrics",
        icon: BarChart3,
        active: location.pathname === "/metrics",
      },
      {
        to: "/ai",
        label: "AI",
        icon: Sparkles,
        active: location.pathname.startsWith("/ai"),
      },
    ],
    [location.pathname],
  );

  const sidebarContent = (
    <>
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-blue-600 text-white p-1.5 rounded-lg shadow-inner">
            <Activity className="w-5 h-5" />
          </div>
          <h1 className="text-lg font-black text-white tracking-tighter">
            PANOPTICON
          </h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden h-8 w-8 p-0 text-slate-400 hover:text-white"
          onClick={() => setMobileOpen(false)}
        >
          <X className="w-5 h-5" />
        </Button>
      </div>

      <div className="p-3">
        <div className="relative mb-4">
          <Input
            id="globalSearch"
            value={searchValue}
            onChange={(e) => {
              navigate(
                e.target.value
                  ? `/search?q=${encodeURIComponent(e.target.value)}`
                  : "/",
              );
            }}
            placeholder="Search all... (⌘K)"
            className="pl-8 bg-slate-950 border-slate-800 text-xs"
          />
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
        </div>

        <nav className="space-y-1">
          {navItems.map(({ to, label, icon: Icon, active }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-all",
                active
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200",
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-auto p-4 border-t border-slate-800 bg-slate-950/50">
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 mb-3">
          <span className="flex items-center space-x-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            <span>LIVE</span>
          </span>
          <span>localhost:3000</span>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-400 hover:text-white"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="bg-blue-600 text-white p-1 rounded-md">
            <Activity className="w-4 h-4" />
          </div>
          <span className="text-sm font-black text-white tracking-tighter">
            PANOPTICON
          </span>
        </div>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/60"
          onClick={() => setMobileOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMobileOpen(false);
          }}
        />
      )}

      {/* Sidebar — always visible on md+, slide-over on mobile */}
      <div
        className={cn(
          "border-r border-slate-800 bg-slate-900 flex flex-col h-full shrink-0 w-64",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:transition-transform max-md:duration-200",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          "hidden md:flex",
          mobileOpen && "!flex",
        )}
      >
        {sidebarContent}
      </div>
    </>
  );
}

function MobileTopBarSpacer() {
  return <div className="md:hidden h-[53px] shrink-0" />;
}

function AppLayout() {
  const { sessionId, source, eventId } = useParams();
  const hasEvent = !!(source && eventId);

  return (
    <ResizablePanelGroup direction="horizontal" className="flex-1 h-full">
      <ResizablePanel defaultSize={sessionId ? 40 : 100} minSize={20}>
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </ResizablePanel>

      {sessionId && (
        <>
          <ResizableHandle
            withHandle
            className="bg-slate-800 w-2 max-md:hidden"
          />
          <ResizablePanel
            defaultSize={30}
            minSize={20}
            className="max-md:hidden"
          >
            <Suspense fallback={<PageSkeleton />}>
              <TimelinePanel />
            </Suspense>
          </ResizablePanel>
        </>
      )}

      {hasEvent && (
        <>
          <ResizableHandle
            withHandle
            className="bg-slate-800 w-2 max-md:hidden"
          />
          <ResizablePanel
            defaultSize={30}
            minSize={20}
            className="max-md:hidden"
          >
            <Suspense fallback={<PageSkeleton />}>
              <EventDetailsPanel />
            </Suspense>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

export default function App() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-300">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileTopBarSpacer />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Sessions />} />
            <Route path="/sessions/:sessionId" element={<Sessions />} />
            <Route
              path="/sessions/:sessionId/events/:source/:eventId"
              element={<Sessions />}
            />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/metrics" element={<Metrics />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/ai" element={<AI />} />
            <Route path="/ai/:chatId" element={<AI />} />
          </Route>
        </Routes>
      </div>
    </div>
  );
}
