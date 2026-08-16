const RENDER_API_KEY = 'rnd_xJ24RkQvYAss79tMRHt9n1kqk1Mq';
const OWNER_ID = 'tea-d3787kbe5dus7394brlg';

const payload = {
  type: "web_service",
  ownerId: OWNER_ID,
  name: "test-pb-" + Date.now(),
  region: "oregon",
  plan: "free",
  runtime: "image",
  image: "pocketbase/pocketbase:latest",
  serviceDetails: {
    envVars: [
      { key: "POCKETBASE_ADMIN_EMAIL", value: "admin@test.com" },
      { key: "POCKETBASE_ADMIN_PASSWORD", value: "password123" }
    ],
    disk: {
      name: "pb-data",
      mountPath: "/pb_data",
      sizeGB: 1
    }
  }
};

(async () => {
  const res = await fetch("https://api.render.com/v1/services", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RENDER_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
})();
