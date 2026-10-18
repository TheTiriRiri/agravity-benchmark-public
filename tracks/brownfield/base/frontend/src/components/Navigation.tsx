import React from 'react';
import {
  LayoutDashboard,
  CalendarDays,
  ClipboardList,
  Boxes,
  RotateCcw,
  Activity,
  Menu,
  X,
} from 'lucide-react';

export type ScreenType = 'dashboard' | 'schedule' | 'work-orders' | 'inventory';

interface NavigationProps {
  currentScreen: ScreenType;
  onSelectScreen: (screen: ScreenType) => void;
  onReset: () => Promise<void>;
  isResetting: boolean;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentScreen,
  onSelectScreen,
  onReset,
  isResetting,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  const navItems: { id: ScreenType; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'schedule', label: 'Schedule', icon: <CalendarDays className="w-4 h-4" /> },
    { id: 'work-orders', label: 'Work Orders', icon: <ClipboardList className="w-4 h-4" /> },
    { id: 'inventory', label: 'Inventory', icon: <Boxes className="w-4 h-4" /> },
  ];

  return (
    <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand Logo & Name */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-lg shadow-cyan-500/20 ring-1 ring-white/20">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-bold tracking-tight text-white flex items-center gap-2">
                <span>Meridian</span>
                <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60 uppercase">
                  Console
                </span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono">Industrial PM Dispatch</div>
            </div>
          </div>

          {/* Desktop Navigation Tabs */}
          <nav className="hidden md:flex items-center space-x-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
            {navItems.map((item) => {
              const active = currentScreen === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectScreen(item.id)}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                    active
                      ? 'bg-slate-800 text-cyan-400 shadow-sm border border-slate-700'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={onReset}
              disabled={isResetting}
              title="Reset state to seed data"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white border border-slate-700 transition disabled:opacity-50"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin text-cyan-400' : ''}`} />
              <span className="hidden sm:inline">Reset Seed</span>
            </button>

            {/* Mobile hamburger button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-800 bg-slate-900 px-4 pt-2 pb-3 space-y-1">
          {navItems.map((item) => {
            const active = currentScreen === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectScreen(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-base font-medium transition ${
                  active
                    ? 'bg-slate-800 text-cyan-400 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
};
