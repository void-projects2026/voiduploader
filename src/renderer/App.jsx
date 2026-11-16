import React, { useState } from 'react';
import { ToastProvider } from './context/ToastContext.jsx';
import { SessionProvider, useSession } from './context/SessionContext.jsx';
import { OpsProvider } from './context/OpsContext.jsx';
import { WorkProvider } from './context/WorkContext.jsx';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import AnimeTab from './components/AnimeTab.jsx';
import UploadTab from './components/UploadTab.jsx';
import OpsTab from './components/OpsTab.jsx';
import SettingsTab from './components/SettingsTab.jsx';
import ToolTab from './components/ToolTab.jsx';
import LibraryTab from './components/LibraryTab.jsx';
import DeletePrompt from './components/DeletePrompt.jsx';
import { ToolProvider } from './context/ToolContext.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';

function Shell() {
  const { profile, loading } = useSession();
  const [activeTab, setActiveTab] = useState('upload');

  if (loading) {
    return <div className="h-screen flex items-center justify-center text-zinc-500 text-sm">جارِ التحميل...</div>;
  }

  if (!profile) return <Login />;

  return (
    <div className="h-screen flex">
      <UpdateBanner />
      <DeletePrompt />
      <Sidebar active={activeTab} onChange={setActiveTab} />
      <main className="flex-1 overflow-y-auto p-7">
        {activeTab === 'anime' && <AnimeTab />}
        {activeTab === 'upload' && <UploadTab />}
        {activeTab === 'tool' && <ToolTab />}
        {activeTab === 'library' && <LibraryTab />}
        {activeTab === 'ops' && <OpsTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <OpsProvider>
          <WorkProvider>
            <ToolProvider>
              <Shell />
            </ToolProvider>
          </WorkProvider>
        </OpsProvider>
      </SessionProvider>
    </ToastProvider>
  );
}
