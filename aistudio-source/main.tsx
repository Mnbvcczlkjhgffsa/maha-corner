import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Configure PDF.js worker externally (eliminates inline <script> from index.html for strict CSP)
const globalWin = window as unknown as {
  pdfjsLib?: { GlobalWorkerOptions?: { workerSrc: string } };
};
if (globalWin.pdfjsLib?.GlobalWorkerOptions) {
  globalWin.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
}

createRoot(document.getElementById('root')!).render(<App />);