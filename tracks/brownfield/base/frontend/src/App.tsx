import React, { useState } from 'react';
import { Navigation, ScreenType } from './components/Navigation';
import { DashboardView } from './views/DashboardView';
import { ScheduleView } from './views/ScheduleView';
import { WorkOrdersView } from './views/WorkOrdersView';
import { InventoryView } from './views/InventoryView';
import { api } from './services/api';

export const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<ScreenType>('dashboard');
  const [isResetting, setIsResetting] = useState(false);
  const [workOrderStatusFilter, setWorkOrderStatusFilter] = useState<string | undefined>(undefined);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      await api.resetData();
      // Increment refresh key to cause views to re-mount/reload
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error('Failed to reset data', err);
    } finally {
      setIsResetting(false);
    }
  };

  const handleNavigateToWorkOrders = (statusFilter?: string) => {
    setWorkOrderStatusFilter(statusFilter);
    setSelectedOrderId(null);
    setCurrentScreen('work-orders');
  };

  const handleSelectWorkOrderFromSchedule = (woId: string) => {
    setSelectedOrderId(woId);
    setWorkOrderStatusFilter(undefined);
    setCurrentScreen('work-orders');
  };

  return (
    <div className="min-h-screen bg-[#090f1d] text-slate-100 flex flex-col font-sans">
      <Navigation
        currentScreen={currentScreen}
        onSelectScreen={(screen) => {
          if (screen === 'work-orders' && currentScreen !== 'work-orders') {
            setWorkOrderStatusFilter(undefined);
          }
          setCurrentScreen(screen);
        }}
        onReset={handleReset}
        isResetting={isResetting}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {currentScreen === 'dashboard' && (
          <DashboardView
            key={`dashboard-${refreshKey}`}
            onNavigateToWorkOrders={handleNavigateToWorkOrders}
            onNavigateToInventory={() => setCurrentScreen('inventory')}
          />
        )}

        {currentScreen === 'schedule' && (
          <ScheduleView
            key={`schedule-${refreshKey}`}
            onSelectWorkOrder={handleSelectWorkOrderFromSchedule}
          />
        )}

        {currentScreen === 'work-orders' && (
          <WorkOrdersView
            key={`orders-${refreshKey}`}
            initialStatusFilter={workOrderStatusFilter}
            selectedOrderId={selectedOrderId}
            onSelectOrder={setSelectedOrderId}
          />
        )}

        {currentScreen === 'inventory' && (
          <InventoryView key={`inventory-${refreshKey}`} />
        )}
      </main>

      <footer className="border-t border-slate-800/80 bg-slate-950/80 py-4 text-center text-xs text-slate-400 font-mono">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>Meridian Maintenance Console &bull; Preventive Maintenance Dispatch</div>
          <div className="text-slate-400">Deterministic Grid Scheduling Engine</div>
        </div>
      </footer>
    </div>
  );
};

export default App;
