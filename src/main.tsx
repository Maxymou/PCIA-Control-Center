import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/theme.css';
import './styles/app.css';
import '@xyflow/react/dist/style.css';
import { bootLiveData } from './store/useLiveStore';
import { bootConfig } from './store/useConfigStore';

bootLiveData();
bootConfig();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
