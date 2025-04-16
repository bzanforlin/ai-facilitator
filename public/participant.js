const ws = new WebSocket('ws://localhost:8080');

let pendingCoachMessage = null;
let releasePending = false; // 🔄 new flag

ws.onopen = () => {
    console.log('🧑‍🤝‍🧑 Participant WebSocket connected');
};

ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);

        if (data.type === 'openai-response') {
            console.log('📨 OpenAI response received on participant screen');
            pendingCoachMessage = data.data.text;
        
            // Start pulsing
            const pulse = document.getElementById('pulse-circle');
            pulse.classList.remove('pulse-inert');
            pulse.classList.add('pulse-active');
        
            // 🧠 If already released, show it
            if (releasePending) {
                showCoachMessage();
            }
        
        } else if (data.type === 'release-response') {
            console.log('✅ Facilitator released the response to participants');
        
            releasePending = true; // set this first
        
            // 🧠 If message is already here, show it
            if (pendingCoachMessage) {
                showCoachMessage();
            }
        }
    } catch (err) {
        console.error('❌ Error parsing message on participant screen:', err);
    }
};

function showCoachMessage() {
    const coachBox = document.getElementById('coach-response-box');
    coachBox.innerText = pendingCoachMessage;
    coachBox.style.display = 'block';

    const pulse = document.getElementById('pulse-circle');
    pulse.classList.remove('pulse-active');
    pulse.classList.add('pulse-inert');

    pendingCoachMessage = null;
    releasePending = false;
}