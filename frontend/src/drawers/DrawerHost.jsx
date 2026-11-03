import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import UserDrawer from './UserDrawer.jsx';
import EvidenceDrawer from './EvidenceDrawer.jsx';
import ModelDrawer from './ModelDrawer.jsx';

// URL-linked drawers: ?user=<personKey>  ?model=<platform>:<model>  ?check=<checkId>[:<platform>]
// Opening pushes a history entry so Back closes the drawer. A drawer opened from a pasted URL
// closes by replacing the URL instead.
const DrawerContext = createContext({ openUser() {}, openCheck() {}, openModel() {}, close() {} });
const KEYS = ['user', 'model', 'check'];

export function useDrawers() {
  return useContext(DrawerContext);
}

export default function DrawerHost({ children }) {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const pushed = useRef(false);

  const open = useCallback((key, value) => {
    const next = new URLSearchParams(sp);
    KEYS.forEach((k) => next.delete(k));
    next.set(key, value);
    pushed.current = true;
    setSp(next, { replace: false });
  }, [sp, setSp]);

  const close = useCallback(() => {
    if (pushed.current) { pushed.current = false; navigate(-1); return; }
    const next = new URLSearchParams(sp);
    KEYS.forEach((k) => next.delete(k));
    setSp(next, { replace: true });
  }, [sp, setSp, navigate]);

  const api = useMemo(() => ({
    openUser: (key) => open('user', key),
    openCheck: (id, platform) => open('check', platform ? id + ':' + platform : id),
    openModel: (platform, model) => open('model', platform + ':' + model),
    close
  }), [open, close]);

  const user = sp.get('user');
  const model = sp.get('model');
  const check = sp.get('check');
  const [mPlatform, ...mRest] = (model || '').split(':');
  const [cId, cPlatform] = (check || '').split(':');

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <UserDrawer open={!!user} id={user} onClose={close} />
      <ModelDrawer open={!!model} id={model} platform={mPlatform} model={mRest.join(':')} onClose={close} />
      <EvidenceDrawer open={!!check} id={cId} platform={cPlatform || null} onClose={close} />
    </DrawerContext.Provider>
  );
}
