import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQuery, useServices } from './AppContext';
import { navigate } from './router';
import { Btn } from '../ui/components';
import { st } from '../ui/style';
import { APP_NAME } from '../domain/settings';

/** Short guide shown at the first launch (and again from Impostazioni → Generale). */
export function FirstLaunchGuide() {
  const { repo } = useServices();
  const seen = useQuery((r) => r.getSettings().guideSeen);
  if (seen) return null;
  return <GuideSheet onClose={() => repo.updateSettings({ guideSeen: true })} />;
}

const SQUARES: Array<[string, string, string]> = [
  ['a', 'Presente', 'eri a lezione'],
  ['x', 'Assente', 'da recuperare: la trovi in “Da recuperare”'],
  ['r', 'Recuperata', 'assenza recuperata (registrazione, appunti…)'],
  ['t', 'Da confermare', 'lezione passata di cui non hai ancora detto nulla'],
  ['f', 'Da svolgere', 'lezione futura'],
];

export function GuideSheet({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const native = Capacitor.isNativePlatform();
  const pages = [
    {
      title: `Benvenuto in ${APP_NAME}`,
      body: (
        <>
          <p style={P}>Lezioni, presenze, esami, calendario e documenti, tutto su questo iPad: nessun account, nessun server.</p>
          <p style={P}>Due cose da sapere prima di iniziare: cosa vogliono dire i quadrati delle presenze e come collegare il Calendario di Apple.</p>
        </>
      ),
    },
    {
      title: 'I quadrati delle presenze',
      body: (
        <>
          <p style={P}>Ogni quadrato è una lezione. Il suo aspetto dice com’è andata:</p>
          <div style={st('margin:6px 0 10px')}>
            {SQUARES.map(([g, name, desc]) => (
              <div key={g} style={st('display:flex;align-items:center;gap:14px;min-height:50px;border-top:1px solid #EBEBE6')}>
                <span className={`g ${g} lg`} style={{ width: 26, height: 26 }} />
                <span><b style={st('font-weight:650')}>{name}</b> <span className="mu">· {desc}</span></span>
              </div>
            ))}
          </div>
          <p style={P}>Per cambiare una presenza <b>tocca il quadrato</b> nella pagina del corso: passa a presente, assente, recuperata. Oppure usa <b>Registra presenze</b> in Oggi per segnare tutte le lezioni da confermare in fila.</p>
        </>
      ),
    },
    {
      title: 'Il Calendario di Apple',
      body: (
        <>
          <p style={P}>{APP_NAME} ha il suo calendario e può collegarsi a quello di Apple, nei due sensi:</p>
          <ol style={st('padding-left:22px;margin:6px 0 12px;font-size:17px;line-height:1.5')}>
            <li>Apri <b>Calendario</b> e tocca <b>Gestisci calendari</b>.</li>
            <li>Accendi <b>Calendario di Apple</b> e consenti l’accesso quando l’iPad lo chiede.</li>
            <li><b>Cosa PRCD legge:</b> accendi i calendari di Apple che vuoi vedere accanto alle lezioni (Casa, Lavoro…). PRCD non li modifica mai.</li>
            <li><b>Cosa PRCD scrive:</b> se vuoi, accendi <b>Pubblica le lezioni</b>: compaiono nel calendario «Procedo» di Apple, anche su iPhone e Mac.</li>
          </ol>
          <p style={P}>Poi si sincronizza da solo: all’apertura, quando cambi qualcosa e ogni 5 minuti.</p>
          {!native && <p className="mu" style={st('font-size:15px')}>Nota: questo funziona nell’app installata sull’iPad, non nella versione web di Safari.</p>}
        </>
      ),
    },
  ];
  const last = step === pages.length - 1;
  const page = pages[step];
  return (
    <div className="scrim" style={{ zIndex: 70 }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={page.title} style={{ maxWidth: 620, maxHeight: 'calc(100vh - 48px)' }}>
        <div className="body" style={st('padding:26px 30px 10px')}>
          <div className="mu" style={st('font-size:14px;margin-bottom:6px')}>{step + 1} di {pages.length}</div>
          <h2 style={st('margin:0 0 12px;font-size:28px;font-weight:750;letter-spacing:-0.02em')}>{page.title}</h2>
          {page.body}
        </div>
        <footer style={st('display:flex;gap:10px;padding:14px 30px 20px;border-top:1px solid #EBEBE6;align-items:center')}>
          <Btn variant="ghost" onClick={onClose}>Salta</Btn>
          <span style={st('flex:1')} />
          {step > 0 && <Btn onClick={() => setStep(step - 1)}>Indietro</Btn>}
          {last && native ? (
            <>
              <Btn onClick={onClose}>Più tardi</Btn>
              <Btn variant="p" onClick={() => { onClose(); navigate('/calendari'); }}>Collega il calendario</Btn>
            </>
          ) : (
            <Btn variant="p" onClick={() => (last ? onClose() : setStep(step + 1))}>{last ? 'Inizia' : 'Avanti'}</Btn>
          )}
        </footer>
      </section>
    </div>
  );
}

const P: React.CSSProperties = { fontSize: 17, lineHeight: 1.5, margin: '0 0 10px' };
