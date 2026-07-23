import { exec } from "node:child_process";

export function showRevision(request, response) {
  const revision = request.query.revision;

  exec(`git show ${revision}`, (error, stdout) => {
    if (error) {
      response.status(500).send(error.message);
      return;
    }

    response.type("text/plain").send(stdout);
  });
}
