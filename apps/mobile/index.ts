// Keep the entrypoint in THIS checkout. Expo's package-relative AppEntry can
// otherwise import an older App when node_modules is reused through a junction.
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
