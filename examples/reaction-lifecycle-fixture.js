import { exec } from "node:child_process";

export function showRevision(request, response) {
  exec(`git show ${request.query.revision}`, (error, output) => {
    if (error) return response.status(500).send(error.message);
    response.type("text/plain").send(output);
  });
}
