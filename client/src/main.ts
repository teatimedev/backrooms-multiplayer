import './style.css';
import { Net } from './net';
import { UI } from './ui';
import { Game } from './game';

const ui = new UI();
ui.showTitle();

let game: Game | null = null;

ui.onIntent = async (intent) => {
  ui.showLoading('DESCENDING…');
  const net = new Net();
  try {
    await net.connect();
  } catch {
    ui.showTitle('could not reach the server — is it running?');
    return;
  }
  net.on('err', (m) => {
    if (!game) ui.showTitle(m.msg);
  });
  net.on('joined', (m) => {
    game?.dispose();
    game = new Game(net, ui, m, intent.voice);
  });
  if (intent.mode === 'host') net.send({ t: 'host', name: intent.name, color: intent.color });
  else net.send({ t: 'join', code: intent.code, name: intent.name, color: intent.color });
};
