class InteractionObserver {
    constructor() {
        console.log('Initializing InteractionObserver');
        this.ws = new WebSocket('ws://localhost:8080');
        this.isProcessingAudio = false;  // Add flag to track audio processing
        this.audioContext = null;
        this.currentInterim = {}; // Initialize the interim transcript tracker
        this.setupWebSocket();
        this.setupTriggerButtons();
        this.setupReleaseButton();
        this.setupAudioCapture();
    }

    setupWebSocket() {
        this.ws.onopen = () => {
            console.log('WebSocket opened. State:', this.ws.readyState);
        };

        this.ws.onclose = () => {
            console.log('WebSocket closed');
            this.isProcessingAudio = false;  // Reset flag when connection closes
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
        
                if (data.type === 'transcript') {
                    this.updateTranscript(data.data);
                } else if (data.type === 'openai-response') {
                    console.log('OpenAI response:', data.data.text); // 👈 THIS IS WHAT YOU WANT
                    this.pendingResponse = data.data.text;

                    // Enable release button
                    const releaseButton = document.getElementById('release-response');
                    if (releaseButton) {
                        releaseButton.disabled = false;
                    }

                    // Flash the pulse circle
                    const pulse = document.getElementById('pulse-circle');
                    if (pulse) {
                        pulse.classList.remove('pulse-inert');
                        pulse.classList.add('pulse-active');
                    }
                } else {
                    console.warn('Unknown message type:', data.type);
                }
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };
    }

    setupTriggerButtons() {
        console.log('Frontend: Setting up trigger buttons');
        document.querySelectorAll('.trigger-btn').forEach(button => {
            button.addEventListener('click', () => {
                const trigger = button.dataset.trigger;
                const triggerText = button.textContent;
                console.log('Trigger clicked:', triggerText);

                // Add trigger event to transcript
                this.addTriggerToTranscript(trigger, triggerText);

                // IMPORTANT: Temporarily pause audio sending
                const wasProcessing = this.isProcessingAudio;
                this.isProcessingAudio = false;

                // Send trigger event without interrupting audio
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'trigger',
                        trigger: trigger,
                        timestamp: new Date().toISOString()
                    }));

                    // Resume audio processing after a short delay
                    setTimeout(() => {
                        this.isProcessingAudio = wasProcessing;
                    }, 200); // Short delay to let the WebSocket process the trigger
                }
            });
        });
    }

    setupReleaseButton() {
        const releaseButton = document.getElementById('release-response');
        if (releaseButton) {
            releaseButton.disabled = true; // Initially disabled
            
            releaseButton.addEventListener('click', () => {
                if (this.pendingResponse) {
                    console.log('Releasing response:', this.pendingResponse);

                    // Add the response to the transcript
                    this.addResponseToTranscript(this.pendingResponse);

                    // 🔄 NEW: Send "release-response" to all clients (including participant)
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            type: 'release-response',
                            timestamp: new Date().toISOString()
                        }));
                    }

                    // Show in the pulse response box
                    const coachBox = document.getElementById('coach-response-box');
                    if (coachBox) {
                        coachBox.innerText = this.pendingResponse;
                        coachBox.style.display = 'block';
                    }

                    // Stop pulse
                    const pulse = document.getElementById('pulse-circle');
                    if (pulse) {
                        pulse.classList.remove('pulse-active');
                        pulse.classList.add('pulse-inert');
                    }

                    this.pendingResponse = null;
                    releaseButton.disabled = true;
                }
            });
        } else {
            console.error('Release response button not found');
        }
    }

    addTriggerToTranscript(triggerType, triggerText) {
        const container = document.getElementById('transcript-container');
        const entry = document.createElement('div');
        entry.className = `transcript-entry trigger-event trigger-${triggerType}`;
        
        const timestamp = new Date().toLocaleTimeString();
        entry.textContent = `[${timestamp}] TRIGGER: ${triggerText}`;
        
        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;
    }

    addResponseToTranscript(responseText) {
        const container = document.getElementById('transcript-container');
        const entry = document.createElement('div');
        entry.className = 'transcript-entry coach-response';
        
        const timestamp = new Date().toLocaleTimeString();
        entry.textContent = `[${timestamp}] COACH: ${responseText}`;
        
        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;
    }

    async setupAudioCapture() {
        console.log('Setting up audio capture');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 48000,
                    echoCancellation: true,
                    noiseSuppression: true
                } 
            });
            
            console.log('Audio permissions granted');
            
            this.audioContext = new AudioContext({
                sampleRate: 48000,
                latencyHint: 'interactive'
            });

            console.log('AudioContext created. Sample rate:', this.audioContext.sampleRate);

            const source = this.audioContext.createMediaStreamSource(stream);
            const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

            source.connect(processor);
            processor.connect(this.audioContext.destination);

            processor.onaudioprocess = (e) => {
                if (this.ws.readyState === WebSocket.OPEN && this.isProcessingAudio) {
                    const inputData = e.inputBuffer.getChannelData(0);
                    const int16Data = new Int16Array(inputData.length);
                    
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    // Send audio data with type identifier
                    try {
                        this.ws.send(int16Data.buffer);
                    } catch (error) {
                        console.error('Error sending audio data:', error);
                        // Don't stop processing on error
                    }
                }
            };

            console.log('Audio processing setup complete');
        } catch (error) {
            console.error('Error in audio setup:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack
            });
        }

        this.isProcessingAudio = true;
        console.log('Audio processing setup complete');
    }

    updateTranscript(data) {
        // Guard clause: if data is missing or invalid, exit early.
        if (!data || data.timestamp == null || data.text == null) {
            console.warn('Invalid transcript data received:', data);
            return;
        }

        const container = document.getElementById('transcript-container');
        if (!container) {
            console.error('Transcript container not found!');
            return;
        }

        // If the transcript text is empty, return early (skip)
        if (!data.text) {
            return;
        }

        const timeString = new Date(data.timestamp).toLocaleTimeString();
        const displayText = `[${timeString}] Speaker ${data.speaker}: ${data.text}`;

        // Check if we have an interim transcript for this speaker
        if (!data.isFinal) {
            // If exists, update the text; otherwise, create a new element and store it
            if (this.currentInterim[data.speaker]) {
                this.currentInterim[data.speaker].textContent = displayText;
            } else {
                const entry = document.createElement('div');
                entry.className = `transcript-entry speaker-${data.speaker}`;
                entry.textContent = displayText;
                container.appendChild(entry);
                container.scrollTop = container.scrollHeight;
                this.currentInterim[data.speaker] = entry;
            }
        } else {
            // For final transcripts, create a new element and clear any interim record for that speaker
            const entry = document.createElement('div');
            entry.className = `transcript-entry speaker-${data.speaker}`;
            entry.textContent = displayText;
            container.appendChild(entry);
            container.scrollTop = container.scrollHeight;
            // Clear the interim record so the next transcript is fresh
            delete this.currentInterim[data.speaker];
        }
    }

}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing application');
    new InteractionObserver();
}); 