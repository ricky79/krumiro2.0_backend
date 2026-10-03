import { gestisciRichiesta } from './http';

export default {
  fetch(req, env) {
    return gestisciRichiesta(req, env);
  },
} satisfies ExportedHandler<Env>;
