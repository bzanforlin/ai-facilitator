require('dotenv').config();
const express = require('express');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;
const axios = require('axios');

// Initialize Deepgram with new v3 format
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Create WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

// Store events and transcripts
const sessionData = {
    triggers: [],
    transcripts: []
};

// Define your collaboration coach prompt
const coachPrompt = `You are an expert facilitator whose goal is to support and enhance collaboration between two students who are working together to make a group decision. The activity they are performing is focused explicitly on deliberation. They are making a decision together.

Your role is to act as a collaboration coach. You should help the participants work together more effectively by intervening when necessary. You are not there to provide content-specific answers but to guide the interaction, ensuring that they share their reasoning, ask clarifying questions, and distribute the conversational floor evenly.

You will be prompted to respond in some specific moments of the interaction, usually after one of these triggers was identified:
Metacognitive gaps / deviation from goal: The conversation drifts away from the decision-making goal.
Absence of a participant: One participant is not speaking or contributing.
Defensive behavior / Unprompted justification: A participant is justifying a point without being challenged, without going deep into the reasons or “whys,” or using abstract, vague terminology.
Superficial explanation: A participant does not go deep into the reasons or “whys” of an opinion, under-explaining ideas as if assuming something is obvious

Here are some examples of behaviors you may employ when appropriate:
Ask someone what they understood of the other person’s point.
Bring the conversation back to the discussion’s goal.
Rephrase something that was said to ensure understanding. Highlight what has been agreed upon.
Ask for a concrete example when there is ambiguity.
Invite a quieter participant to share their thoughts.
Point out patterns in the conversation.
Introduce a structured decision-making method (e.g., pros and cons, ranking, etc.).
Summarize key discussion moments so far.
Use light humor to defuse tension when appropriate.

Be very brief in your response, stating what you noticed and suggesting what to do. Address participants in a way that is not prompting them to speak with you, but rather with each other.
You will notice repetitions in words and sentences in the transcript - ignore them, this is a problem with the transcription system.
In all your interventions, remember: Your goal is to support better collaboration, not to direct the content of the discussion. Because you will respond participants with some delay, you shouldn't try to interact specifically to their last message, but make more general observations.`;

// Utility function to call OpenAI's API
async function callOpenAI(triggerInfo, conversationText) {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    try {
        // We'll use the Chat Completions endpoint with gpt-3.5-turbo
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: coachPrompt },
                    { 
                        role: "user", 
                        content: `${triggerInfo}\n\nConversation so far:\n${conversationText}` 
                    }
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error calling OpenAI:', error.response?.data || error.message);
        console.log('Conversation text length:', conversationText.length);
        return null;
    }
}

// Updated WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('WebSocket: New client connected');
    
    // Log the Deepgram API key status (masked for security)
    const apiKeyPreview = process.env.DEEPGRAM_API_KEY 
        ? `${process.env.DEEPGRAM_API_KEY.substr(0, 4)}...${process.env.DEEPGRAM_API_KEY.substr(-4)}`
        : 'NOT SET';
    console.log('Deepgram API Key status:', apiKeyPreview ? 'Present' : 'Missing');

    try {
        // Create live transcription connection with new format
        const dgConnection = deepgram.listen.live({ 
            model: "nova",
            language: 'en-US',
            smart_format: true,
            diarize: true,
            interim_results: true,
            encoding: 'linear16',
            sample_rate: 48000,
            channels: 1
        });

        console.log('Deepgram connection object created');

        // Use the new LiveTranscriptionEvents format
        dgConnection.on(LiveTranscriptionEvents.Open, () => {
            console.log('✓ Deepgram connection opened');

            // Add transcript event listener INSIDE the open event
            dgConnection.on(LiveTranscriptionEvents.Transcript, (message) => {
                
                try {
                    if (message.channel?.alternatives?.[0]) {
                        const alternative = message.channel.alternatives[0];
                        
                        // Get the speaker from the first word
                        const speaker = alternative.words?.[0]?.speaker || 0;
                        const transcriptText = alternative.transcript;

                        // Simplified log output
                        console.log(`Speaker ${speaker}: ${transcriptText}`);

                        const transcriptData = {
                            timestamp: new Date().toISOString(),
                            speaker: speaker,
                            text: alternative.transcript,
                            isFinal: message.is_final
                        };

                        // Append to sessionData (store only final transcripts, for example)
                        if (transcriptData.isFinal) {
                            sessionData.transcripts.push(transcriptData);
                        }

                        // Send transcript data to the client
                        ws.send(JSON.stringify({ 
                            type: 'transcript', 
                            data: transcriptData 
                        }));
                    }
                } catch (error) {
                    console.error('! Error processing transcript:', error);
                }
            });

            // Add error and close listeners
            dgConnection.on('error', (error) => {
                console.error('! Deepgram error:', error);
            });

            dgConnection.on('close', () => {
                console.log('× Deepgram connection closed');
            });
        });

        ws.on('message', async (message, isBinary) => {
            try {
                if (!isBinary) {
                    // Handle JSON/text messages (e.g., trigger)
                    const messageText = message.toString();
        
                    // Log received message
                    console.log('📩 String message received:', messageText.substring(0, 100));
        
                    let parsed;
                    try {
                        parsed = JSON.parse(messageText);
                    } catch (parseError) {
                        console.error('❌ Failed to parse message as JSON:', parseError);
                        return;
                    }
        
                    const { type, trigger, timestamp } = parsed;
        
                    if (type === 'trigger') {
                        console.log(`🟢 Trigger received: ${trigger}`);
        
                        // Compile the conversation transcript so far
                        const conversationText = sessionData.transcripts
                            .map(t => `[${t.timestamp}] Speaker ${t.speaker}: ${t.text}`)
                            .join('\n');
        
                        const triggerInfo = `Trigger activated: "${trigger}"`;
                        console.log('🧠 Calling OpenAI with trigger:', triggerInfo);
                        console.log('📝 Transcript character length:', conversationText.length);
        
                        const openaiResponse = await callOpenAI(triggerInfo, conversationText);
        
                        if (openaiResponse?.choices?.[0]?.message?.content) {
                            const content = openaiResponse.choices[0].message.content;
                            console.log('✅ OpenAI response received');
        
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'openai-response',
                                        data: { text: content, timestamp: new Date().toISOString() }
                                    }));
                                }
                            });
                        } else {
                            console.warn('⚠️ OpenAI response missing expected content');
                            ws.send(JSON.stringify({
                                type: 'openai-error',
                                data: { error: 'OpenAI returned no valid response.' }
                            }));
                        }
                    } else if (type === 'release-response') {
                        console.log('📣 Facilitator triggered response release');
                    
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'release-response',
                                    timestamp: new Date().toISOString()
                                }));
                            }
                        });
                    } else {
                        console.log('⚠️ Unknown message type:', type);
                    }
        
                } else {
                    // Handle binary audio data
                    if (dgConnection && dgConnection.getReadyState() === 1) {
                        dgConnection.send(message);
                        // Optional: uncomment for debugging audio input frequency
                        // process.stdout.write('.');
                    } else {
                        console.warn('⚠️ Deepgram connection not ready for audio.');
                    }
                }
            } catch (err) {
                console.error('💥 Error handling WebSocket message:', err);
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected');
            dgConnection.finish();
            
            const filename = `session-${new Date().toISOString()}.json`;
            fs.writeFileSync(
                path.join(__dirname, 'logs', filename),
                JSON.stringify(sessionData, null, 2)
            );
        });

    } catch (error) {
        console.error('Error setting up Deepgram connection:', error);
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});