import { gestisciRichiesta } from './http';
import { eseguiInvio } from './invio';
import { chiaviVapid, inviaPush, verificaChiaviVapid } from './push';

export default {
  fetch(req, env) {
    return gestisciRichiesta(req, env);
  },

  async scheduled(controller, env) {
    const vapid = chiaviVapid(env);
    // Chiavi errate: il giro fallisce senza toccare gli avvisi, che partono quando la configurazione è corretta.
    await verificaChiaviVapid(vapid);
    await eseguiInvio(env.DB, controller.scheduledTime, (avviso) => inviaPush(avviso, vapid));
  },
} satisfies ExportedHandler<Env>;
