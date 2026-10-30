import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TOOL_CONFIG } from './data/tools';
import { LocaleProvider, type Locale } from './lib/i18n';

const VideoStudio = lazy(() => import('./pages/VideoStudio').then((m) => ({ default: m.VideoStudio })));
const ImageStudio = lazy(() => import('./pages/ImageStudio').then((m) => ({ default: m.ImageStudio })));
const CanvasPage = lazy(() => import('./pages/CanvasPage').then((m) => ({ default: m.CanvasPage })));
const PromptsPage = lazy(() => import('./pages/PromptsPage').then((m) => ({ default: m.PromptsPage })));
const CinematographyPage = lazy(() =>
  import('./pages/CinematographyPage').then((m) => ({ default: m.CinematographyPage })),
);
const AssetsPage = lazy(() => import('./pages/AssetsPage').then((m) => ({ default: m.AssetsPage })));
const TeamPage = lazy(() => import('./pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const BillingPage = lazy(() => import('./pages/BillingPage').then((m) => ({ default: m.BillingPage })));
const ToolPage = lazy(() => import('./pages/ToolPage').then((m) => ({ default: m.ToolPage })));

function page(element: ReactNode) {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">正在加载…</div>}>
      {element}
    </Suspense>
  );
}

function LocalizedShell() {
  const { locale } = useParams();
  if (locale !== 'zh' && locale !== 'en') return <Navigate to="/zh/video" replace />;
  return (
    <LocaleProvider locale={locale as Locale}>
      <AppShell />
    </LocaleProvider>
  );
}

function localizedPages() {
  return (
    <>
      <Route index element={<Navigate to="video" replace />} />
      <Route path="video" element={page(<VideoStudio />)} />
      <Route path="image" element={page(<ImageStudio />)} />
      <Route path="canvas" element={page(<CanvasPage />)} />
      <Route path="prompts" element={page(<PromptsPage />)} />
      <Route path="cinematography" element={page(<CinematographyPage />)} />
      <Route path="assets" element={page(<AssetsPage />)} />
      <Route path="team" element={page(<TeamPage />)} />
      <Route path="admin" element={page(<AdminPage />)} />
      <Route path="billing" element={page(<BillingPage />)} />
      {Object.values(TOOL_CONFIG).map((cfg) => (
        <Route key={cfg.path} path={cfg.path.slice(1)} element={page(<ToolPage config={cfg} />)} />
      ))}
      <Route path="*" element={<Navigate to="video" replace />} />
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route
        element={
          <LocaleProvider locale="zh" prefixed={false}>
            <AppShell />
          </LocaleProvider>
        }
      >
        <Route path="/" element={<Navigate to="/video" replace />} />
        <Route path="/video" element={page(<VideoStudio />)} />
        <Route path="/image" element={page(<ImageStudio />)} />
        <Route path="/canvas" element={page(<CanvasPage />)} />
        <Route path="/prompts" element={page(<PromptsPage />)} />
        <Route path="/cinematography" element={page(<CinematographyPage />)} />
        <Route path="/assets" element={page(<AssetsPage />)} />
        <Route path="/team" element={page(<TeamPage />)} />
        <Route path="/admin" element={page(<AdminPage />)} />
        <Route path="/billing" element={page(<BillingPage />)} />
        {Object.values(TOOL_CONFIG).map((cfg) => (
          <Route key={cfg.path} path={cfg.path} element={page(<ToolPage config={cfg} />)} />
        ))}
        <Route path="*" element={<Navigate to="/video" replace />} />
      </Route>
      <Route path="/:locale" element={<LocalizedShell />}>
        {localizedPages()}
      </Route>
    </Routes>
  );
}
