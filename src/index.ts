export default {
  async fetch(): Promise<Response> {
    return Response.json({ errore: 'percorso non trovato' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
