import { render } from 'preact';
import { App } from './app';
import '../../ui/src/tokens.css';
import '../../ui/src/workspaces.css';
import './styles.css';

render(<App />, document.getElementById('app')!);
