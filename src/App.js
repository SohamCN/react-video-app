// app.js
import React, { useEffect, useRef, useState, useCallback } from 'react';
import Video from 'twilio-video';
import { Client as ConversationsClient } from '@twilio/conversations';
import axios from 'axios';

const API = 'http://localhost:4020';
const CDN = 'https://cdn.pornyo.com/';

// utility to hide admin identities (prefixed with admin_)
function isAdmin(identity) { return identity && identity.startsWith('admin_'); }

function App() {
  const [appJwt, setAppJwt] = useState(localStorage.getItem('app_jwt') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [messages, setMessages] = useState([]);
  const [joined, setJoined] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [participants, setParticipants] = useState(new Map());
  const [userRole, setUserRole] = useState('');
  const [avatarImage, setAvatarImage] = useState('');
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  const [conversationStatus, setConversationStatus] = useState('disconnected');

  // Refs for Twilio objects only - no DOM manipulation
  const roomRef = useRef(null);
  const localTracksRef = useRef([]);
  const videoElementsRef = useRef(new Map());
  const conversationsClientRef = useRef(null);
  const conversationRef = useRef(null);
  const conversationTokenRef = useRef(null);
  const isUnmountingRef = useRef(false);

  // Helper: stop and detach a track safely
  const stopAndDetachTrack = (track) => {
    try {
      if (!track) return;
      if (typeof track.stop === 'function') track.stop();
      if (typeof track.detach === 'function') {
        const els = track.detach();
        if (Array.isArray(els)) {
          els.forEach(el => el && el.remove && el.remove());
        } else if (els && els.remove) {
          els.remove();
        }
      }
    } catch (e) {
      console.warn('Error stopping/detaching track', e);
    }
  };

  // Safe cleanup function — does NOT shutdown Conversations client to avoid killing it mid-init.
  const cleanup = useCallback(() => {
    console.log('Starting cleanup...');

    // Stop and clean up local tracks
    try {
      localTracksRef.current.forEach(track => stopAndDetachTrack(track));
    } catch (e) {
      console.warn('Error cleaning local tracks', e);
    }
    localTracksRef.current = [];

    // Remove stored video elements
    try {
      videoElementsRef.current.forEach(el => {
        try { if (el && el.remove) el.remove(); } catch {}
      });
      videoElementsRef.current.clear();
    } catch (e) {
      console.warn('Error clearing video elements map', e);
    }

    // Disconnect room
    if (roomRef.current) {
      try { roomRef.current.disconnect(); } catch (e) { console.warn(e); }
      roomRef.current = null;
    }

    // Cleanup conversation listeners but keep the client alive
    if (conversationRef.current) {
      try { conversationRef.current.removeAllListeners && conversationRef.current.removeAllListeners(); } catch (e) { console.warn(e); }
      conversationRef.current = null;
    }

    // Do NOT call conversationsClientRef.current.shutdown() here.
    // We will keep the client alive across joins and only shutdown on unmount.

    // Reset UI state
    setLocalVideoTrack(null);
    setParticipants(new Map());
    setMessages([]);
    setConversationStatus('disconnected');

    console.log('Cleanup completed');
  }, []);

  // On unmount: cleanup and fully shutdown Conversations client
  useEffect(() => {
    return () => {
      isUnmountingRef.current = true;
      cleanup();
      if (conversationsClientRef.current) {
        try { conversationsClientRef.current.shutdown(); } catch (e) { console.warn('Error shutting down conversations client', e); }
        conversationsClientRef.current = null;
        conversationTokenRef.current = null;
      }
    };
  }, [cleanup]);

  // Video component for rendering participant videos
  const VideoComponent = ({ track, participantId, isLocal = false }) => {
    const videoRef = useRef(null);

    useEffect(() => {
      if (track && videoRef.current) {
        const element = track.attach();
        videoRef.current.appendChild(element);

        // Store reference for cleanup
        videoElementsRef.current.set(`${participantId}-${isLocal ? 'local' : 'remote'}`, element);

        return () => {
          try {
            if (element && element.parentNode) element.parentNode.removeChild(element);
          } catch (e) {}
          videoElementsRef.current.delete(`${participantId}-${isLocal ? 'local' : 'remote'}`);
        };
      }
    }, [track, participantId, isLocal]);

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        margin: 4
      }}>
        <div
          ref={videoRef}
          style={{
            width: 320,
            height: 240,
            backgroundColor: '#000',
            borderRadius: 8,
            border: `2px solid ${isLocal ? '#28a745' : '#007bff'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
          }}
        >
          {!track && (
            <span style={{ color: 'white', fontSize: '14px' }}>
              {isLocal ? 'Starting camera...' : 'Loading video...'}
            </span>
          )}
        </div>
        <div style={{
          marginTop: 4,
          padding: '4px 8px',
          backgroundColor: isLocal ? '#28a745' : '#007bff',
          color: 'white',
          borderRadius: 4,
          fontSize: '12px'
        }}>
          {isLocal ? `You (${userRole})` : participantId}
        </div>
      </div>
    );
  };

  // Handle participant state management
  const handleParticipant = useCallback((participant) => {
    const hiddenAdmin = isAdmin(participant.identity);
    if (hiddenAdmin) return; // Skip admin participants

    console.log('Setting up participant:', participant.identity);

    const participantData = {
      identity: participant.identity,
      sid: participant.sid,
      videoTrack: null,
      audioTrack: null,
      connected: true
    };

    // Handle existing tracks
    participant.tracks.forEach(publication => {
      try {
        if (publication.isSubscribed) {
          const track = publication.track;
          if (!track) return;
          if (track.kind === 'video') {
            participantData.videoTrack = track;
          } else if (track.kind === 'audio') {
            participantData.audioTrack = track;
            // Attach audio immediately (hidden)
            try {
              const audioElement = track.attach();
              if (audioElement) {
                audioElement.style.display = 'none';
                document.body.appendChild(audioElement);
              }
            } catch (e) { console.warn('Error attaching audio element', e); }
          }
        }
      } catch (e) { console.warn('Error handling existing publication', e); }
    });

    // Handle future track subscriptions
    participant.on('trackSubscribed', track => {
      console.log('Track subscribed:', track.kind, 'from', participant.identity);

      if (track.kind === 'video') {
        setParticipants(prev => {
          const updated = new Map(prev);
          const existing = updated.get(participant.sid) || {};
          updated.set(participant.sid, { ...existing, videoTrack: track });
          return updated;
        });
      } else if (track.kind === 'audio') {
        try {
          const audioElement = track.attach();
          audioElement.style.display = 'none';
          document.body.appendChild(audioElement);
        } catch (e) { console.warn('Error attaching audio track', e); }

        setParticipants(prev => {
          const updated = new Map(prev);
          const existing = updated.get(participant.sid) || {};
          updated.set(participant.sid, { ...existing, audioTrack: track });
          return updated;
        });
      }
    });

    // Handle track unsubscriptions
    participant.on('trackUnsubscribed', track => {
      console.log('Track unsubscribed:', track.kind, 'from', participant.identity);
      if (track.kind === 'video') {
        setParticipants(prev => {
          const updated = new Map(prev);
          const existing = updated.get(participant.sid) || {};
          updated.set(participant.sid, { ...existing, videoTrack: null });
          return updated;
        });
      }
    });

    // Update participants state
    setParticipants(prev => {
      const updated = new Map(prev);
      updated.set(participant.sid, participantData);
      return updated;
    });

  }, []);

  // Wait until the Conversations client is connected/initialized
  const waitForConversationsReady = (client, timeoutMs = 10000) => {
    return new Promise((resolve, reject) => {
      if (!client) return reject(new Error('Conversations client missing'));
      // Some SDKs expose connectionState; try to resolve immediately if already connected/initialized
      const stateNow = client.connectionState || client.state;
      if (stateNow === 'connected' || stateNow === 'initialized') return resolve();

      const timeout = setTimeout(() => {
        client.removeListener && client.removeListener('stateChanged', handler);
        reject(new Error('Conversations client initialization timeout'));
      }, timeoutMs);

      const handler = (state) => {
        // Accept either 'initialized' or 'connected' depending on SDK
        if (state === 'initialized' || state === 'connected') {
          clearTimeout(timeout);
          client.removeListener && client.removeListener('stateChanged', handler);
          resolve();
        }
      };

      // attach
      try {
        client.on && client.on('stateChanged', handler);
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  };

  const getConversationBySidWithRetry = async (client, conversationSid, attempts = 6, baseDelay = 250) => {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const c = await client.getConversationBySid(conversationSid);
        return c;
      } catch (err) {
        
        lastErr = err;
        const msg = (err && (err.message || '')).toLowerCase();
        const status = err?.status || err?.code;
        const isNotFound = msg.includes('not found') || status === 404;
        const isTwilsock = msg.includes('twilsock') || msg.includes('upstream') || msg.includes('twilsockupstreamerror');

        if (i < attempts - 1 && (isNotFound || isTwilsock)) {
          // Backoff
          const delay = Math.round(baseDelay * Math.pow(1.5, i));
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  // Initialize conversations client
  const initializeConversations = useCallback(async (conversationToken, conversationSid) => {
    try {
      console.log('Initializing Conversations SDK...');
      setConversationStatus('connecting');

      let conversationsClient = conversationsClientRef.current;

      // If token changed, re-create client to ensure fresh credentials
      if (conversationsClient && conversationTokenRef.current !== conversationToken) {
        try {
          conversationsClient.shutdown && conversationsClient.shutdown();
        } catch (e) { console.warn('Error shutting old client', e); }
        conversationsClientRef.current = null;
        conversationTokenRef.current = null;
        conversationsClient = null;
      }

      if (!conversationsClient) {
        conversationsClient = new ConversationsClient(conversationToken);
        conversationsClientRef.current = conversationsClient;
        conversationTokenRef.current = conversationToken;

        conversationsClient.on && conversationsClient.on('stateChanged', (s) => {
          console.log('Conversations client stateChanged ->', s);
          if (s === 'connected' || s === 'initialized') {
            setConversationStatus('connected');
          } else {
            setConversationStatus(String(s));
          }
        });
      }

      // Wait for client to be ready (initialized / connected)
      await waitForConversationsReady(conversationsClient, 12000);

      console.log('Getting conversation (retrying if necessary)...');
      const conversation = await getConversationBySidWithRetry(conversationsClient, conversationSid, 8, 300);
      conversationRef.current = conversation;

      // Load existing messages
      console.log('Loading existing messages...');
      const existingMessages = await conversation.getMessages();
      const formattedMessages = existingMessages.items.map(msg => {
        // Robust avatar extraction with fallback
        let messageAvatar = '';
        try {
          messageAvatar = msg.attributes?.avatarImage || '';
          if (typeof messageAvatar !== 'string') messageAvatar = '';
        } catch (e) {
          console.warn('Error extracting avatar from message attributes:', e);
          messageAvatar = '';
        }

        return {
          username: msg.author || 'Unknown',
          text: msg.body || '',
          ts: msg.dateCreated ? msg.dateCreated.getTime() : Date.now(),
          sid: msg.sid || `msg-${Date.now()}-${Math.random()}`,
          avatarImage: messageAvatar.trim()
        };
      });

      setMessages(formattedMessages);
      console.log(`Loaded ${formattedMessages.length} existing messages`);

      // Ensure no double listeners
      try { conversation.removeAllListeners && conversation.removeAllListeners('messageAdded'); } catch (e) {}
      conversation.on('messageAdded', (message) => {
        console.log('New message received:', message);
        
        // Robust avatar extraction for new messages
        let messageAvatar = '';
        try {
          messageAvatar = message.attributes?.avatarImage || '';
          if (typeof messageAvatar !== 'string') messageAvatar = '';
        } catch (e) {
          console.warn('Error extracting avatar from new message attributes:', e);
          messageAvatar = '';
        }

        const newMessage = {
          username: message.author || 'Unknown',
          text: message.body || '',
          ts: message.dateCreated ? message.dateCreated.getTime() : Date.now(),
          sid: message.sid || `msg-${Date.now()}-${Math.random()}`,
          avatarImage: messageAvatar.trim()
        };

        setMessages(prev => {
          if (prev.some(m => m.sid === message.sid)) return prev;
          return [...prev, newMessage];
        });
      });

      // Join conversation if not joined
      if (conversation.status !== 'joined') {
        try {
          await conversation.join();
          console.log('Joined conversation');
        } catch (e) {
          const msg = (e?.message || '').toLowerCase();
          // Ignore benign "already a member" style errors
          if (!msg.includes('already') && !msg.includes('member')) {
            throw e;
          }
        }
      }

      setConversationStatus('connected');
      console.log('Conversations SDK initialized successfully');

      return conversation;
    } catch (error) {
      console.error('Failed to initialize conversations:', error?.message || error, error?.code, error);
      setConversationStatus('failed');
      throw error;
    }
  }, []);

  // Join room function
  async function joinRoom(roomName) {
    if (!appJwt || !username) return alert('Please provide JWT token and username first');
    if (!roomName?.trim()) return alert('Please enter a room name');

    try {
      setConnectionStatus('connecting');
      console.log('=== JOINING ROOM ===');
      console.log('Room name:', roomName);
      console.log('Username:', username);

      const resp = await axios.post(`${API}/api/frontend/twilio/generateAccessToken`,
        { roomName: roomName.trim() },
        { headers: { Authorization: `Bearer ${appJwt}` } }
      );

      const { 
        token, 
        role, 
        conversationToken, 
        conversationSid, 
        avatarImage: backendAvatarImage 
      } = resp.data || {};
      
      console.log('Received token for role:', role);
      console.log('Conversation SID:', conversationSid);
      console.log('Received avatar image:', backendAvatarImage);
      setUserRole(role || '');
      
      // Set avatar from backend response with validation
      if (backendAvatarImage && typeof backendAvatarImage === 'string' && backendAvatarImage.trim()) {
        setAvatarImage(`${CDN}${backendAvatarImage.trim()}`);
        console.log('Avatar set from backend:', backendAvatarImage.trim());
      } else {
        console.log('No valid avatar received from backend, will use fallback');
        setAvatarImage('');
      }

      // Light reset: stop local tracks and clear UI lists, but DO NOT shutdown the conversations client
      try {
        localTracksRef.current.forEach(track => stopAndDetachTrack(track));
      } catch (e) { console.warn('Error stopping local tracks on join', e); }
      localTracksRef.current = [];
      setLocalVideoTrack(null);
      setParticipants(new Map());
      setMessages([]);

      // Initialize conversations first (with proper waiting + retry)
      await initializeConversations(conversationToken, conversationSid);

      // Create local tracks for video/audio (no DataTrack needed)
      const localTracks = [];

      // Create media tracks for broadcasters only
      if (role === 'broadcaster') {
        console.log('Creating broadcaster media tracks...');
        try {
          const mediaConstraints = {
            audio: {
              echoCancellation: true,
              noiseSuppression: true
            },
            video: {
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 15 }
            }
          };

          const tracks = await Video.createLocalTracks(mediaConstraints);
          localTracksRef.current = [...localTracksRef.current, ...tracks];

          tracks.forEach(track => {
            if (track.kind === 'video') {
              setLocalVideoTrack(track);
            }
            localTracks.push(track);
          });

          console.log('Local media tracks created');
        } catch (mediaError) {
          console.error('Media creation error:', mediaError);
          alert('Failed to access camera/microphone. Please check permissions and try again.');
          setConnectionStatus('disconnected');
          return;
        }
      }

      console.log('Connecting to Twilio room...');
      const room = await Video.connect(token, {
        name: roomName.trim(),
        tracks: localTracks,
        dominantSpeaker: true,
        maxAudioBitrate: 16000,
        maxVideoBitrate: 150000,
        preferredVideoCodecs: ['VP8', 'H264'],
        automaticSubscription: true
      });

      roomRef.current = room;
      setJoined(true);
      setConnectionStatus('connected');

      console.log('=== CONNECTED TO ROOM ===');
      console.log('Room:', room.name);
      console.log('Local participant:', room.localParticipant.identity);

      // Handle participant events
      room.on('participantConnected', participant => {
        console.log('Participant connected:', participant.identity);
        handleParticipant(participant);
      });

      room.on('participantDisconnected', async (participant) => {
        console.log('Participant disconnected:', participant.identity);

        // Call backend to remove participant from conversation
        if (conversationRef.current && appJwt) {
          try {
            const conversationSid = conversationRef.current.sid;
            await axios.post(`${API}/api/frontend/twilio/removeParticipant`,
              { conversationSid, participantIdentity: participant.identity },
              { headers: { Authorization: `Bearer ${appJwt}` } }
            );
            console.log(`Requested backend to remove participant ${participant.identity} from conversation ${conversationSid}.`);
          } catch (error) {
            console.error(`Failed to request participant removal from backend for ${participant.identity}:`, error);
          }
        }

        setParticipants(prev => {
          const updated = new Map(prev);
          updated.delete(participant.sid);
          return updated;
        });
      });

      // Handle existing participants
      room.participants.forEach(participant => {
        console.log('Processing existing participant:', participant.identity);
        handleParticipant(participant);
      });

      // Handle room disconnection
      room.on('disconnected', (_room, error) => {
        console.log('Room disconnected:', error?.message || 'Unknown reason');
        setConnectionStatus('disconnected');
        leaveRoom();
      });

      room.on('reconnecting', () => {
        console.log('Reconnecting...');
        setConnectionStatus('reconnecting');
      });

      room.on('reconnected', () => {
        console.log('Reconnected successfully');
        setConnectionStatus('connected');
      });

    } catch (err) {
      console.error('=== JOIN ROOM ERROR ===', err);
      setConnectionStatus('disconnected');
      setConversationStatus('failed');
      setUserRole('');

      let errorMessage = 'Failed to join room';
      if (err?.response?.data?.message) {
        errorMessage += `: ${err.response.data.message}`;
      } else if (err?.message) {
        errorMessage += `: ${err.message}`;
      }

      alert(errorMessage);
    }
  }

  // Send message using conversations SDK
  async function sendMessage() {
    const chatInput = document.getElementById('chatInput');
    const text = chatInput?.value?.trim();
    if (!text || !conversationRef.current) return;

    try {
      // Prepare attributes with robust avatar handling
      const attributes = {};
      
      // Use backend avatar if available, otherwise generate one
      const messageAvatar = avatarImage && typeof avatarImage === 'string' && avatarImage.trim() 
        ? avatarImage.trim()
        : `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}&background=007bff&color=fff&size=40&rounded=true`;
      
      attributes.avatarImage = messageAvatar;
      
      await conversationRef.current.sendMessage(text, attributes);
      chatInput.value = '';
      console.log('Message sent via Conversations SDK:', text, 'with avatar:', messageAvatar);
    } catch (e) {
      console.error('Send message failed:', e);
      alert('Failed to send message: ' + e.message);
    }
  }

  function leaveRoom() {
    console.log('=== LEAVING ROOM ===');

    // Update state first
    setJoined(false);
    setMessages([]);
    setConnectionStatus('disconnected');
    setConversationStatus('disconnected');
    setUserRole('');
    setLocalVideoTrack(null);
    setParticipants(new Map());

    // Then cleanup (keeps Conversations client alive until unmount)
    cleanup();

    console.log('Left room successfully');
  }

  async function stopBroadcast(roomName) {
    if (!appJwt) return alert('Login required');
    if (!roomName?.trim()) return alert('Please enter a room name');

    try {
      await axios.post(`${API}/api/admin/twilio/stopLiveBroadcast`,
        { roomName: roomName.trim() },
        { headers: { Authorization: `Bearer ${appJwt}` } }
      );
      alert('Broadcast stopped successfully');
      leaveRoom();
    } catch (e) {
      console.error('Stop broadcast error:', e);
      alert(`Stop failed: ${e.response?.data?.message || e.message}`);
    }
  }

  function handleChatKeyPress(e) {
    if (e.key === 'Enter') {
      sendMessage();
    }
  }

  // Calculate participant count
  const participantCount = participants.size + (joined ? 1 : 0);

  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif', maxWidth: 1400 }}>
      <h2>Twilio Video Broadcast with Conversations</h2>

      {/* Status Panel */}
      <div style={{
        marginBottom: 20,
        padding: 16,
        backgroundColor: connectionStatus === 'connected' ? '#d4edda' : '#f8d7da',
        borderRadius: 8,
        border: `2px solid ${connectionStatus === 'connected' ? '#c3e6cb' : '#f5c6cb'}`
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
          <div><strong>Video Status:</strong> {connectionStatus}</div>
          <div><strong>Chat Status:</strong> {conversationStatus}</div>
          <div><strong>Role:</strong> {userRole || 'Not assigned'}</div>
          <div><strong>Total Participants:</strong> {participantCount}</div>
          <div><strong>Username:</strong> {username || 'Not set'}</div>
        </div>
      </div>

      {/* Authentication */}
      <div style={{ marginBottom: 20, padding: 16, backgroundColor: '#f8f9fa', borderRadius: 8 }}>
        <h4>Authentication</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: '12px', marginBottom: 4 }}>JWT Token</label>
            <input
              placeholder="JWT Token (from your backend)"
              defaultValue={appJwt}
              onBlur={e => {
                localStorage.setItem('app_jwt', e.target.value);
                setAppJwt(e.target.value);
              }}
              style={{ minWidth: 300, padding: 8 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: '12px', marginBottom: 4 }}>Username</label>
            <input
              placeholder="Username"
              defaultValue={username}
              onBlur={e => {
                localStorage.setItem('username', e.target.value);
                setUsername(e.target.value);
              }}
              style={{ minWidth: 150, padding: 8 }}
            />
          </div>
          {avatarImage && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', marginBottom: 4 }}>Your Avatar</label>
              <img 
                src={avatarImage}
                alt="Your avatar"
                style={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: '50%', 
                  border: '2px solid #28a745',
                  backgroundColor: '#f8f9fa'
                }}
                onError={(e) => {
                  e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}&background=007bff&color=fff&size=40&rounded=true`;
                }}
              />
            </div>
          )}
        </div>
        {avatarImage && (
          <div style={{ marginTop: 8, fontSize: '12px', color: '#666' }}>
            Avatar loaded from backend: {avatarImage}
          </div>
        )}
      </div>

      {/* Room Controls */}
      <div style={{ marginBottom: 20, padding: 16, backgroundColor: '#f8f9fa', borderRadius: 8 }}>
        <h4>Room Controls</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            id="roomName"
            placeholder="Room Name (e.g., room_1)"
            style={{ padding: 8, minWidth: 200 }}
          />
          <button
            onClick={() => joinRoom(document.getElementById('roomName')?.value)}
            disabled={joined || !appJwt || !username}
            style={{
              padding: 8,
              backgroundColor: joined ? '#6c757d' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: (joined || !appJwt || !username) ? 'not-allowed' : 'pointer'
            }}
          >
            {joined ? 'Connected' : 'Join Room'}
          </button>
          <button
            onClick={leaveRoom}
            disabled={!joined}
            style={{
              padding: 8,
              backgroundColor: joined ? '#dc3545' : '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: 4
            }}
          >
            Leave Room
          </button>
          <button
            onClick={() => stopBroadcast(document.getElementById('roomName')?.value)}
            disabled={!appJwt}
            style={{ padding: 8, backgroundColor: '#ffc107', color: 'black', border: 'none', borderRadius: 4 }}
          >
            Stop Broadcast
          </button>
        </div>
      </div>

      {/* Video Grid */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>

        {/* Local Video */}
        <div style={{ flex: 1 }}>
          <h3>Your Video {userRole && `(${userRole})`}</h3>
          <div style={{
            minHeight: 260,
            border: '2px dashed #28a745',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#f8f9fa',
            padding: 8
          }}>
            {!joined && (
              <span style={{ color: '#666' }}>Not connected to room</span>
            )}
            {joined && userRole === 'viewer' && (
              <span style={{ color: '#666' }}>Viewer mode - no camera needed</span>
            )}
            {joined && userRole === 'broadcaster' && localVideoTrack && (
              <VideoComponent
                track={localVideoTrack}
                participantId={username}
                isLocal={true}
              />
            )}
            {joined && userRole === 'broadcaster' && !localVideoTrack && (
              <span style={{ color: '#666' }}>Starting camera...</span>
            )}
          </div>
        </div>

        {/* Remote Videos */}
        <div style={{ flex: 1 }}>
          <h3>Remote Participants ({participants.size})</h3>
          <div style={{
            minHeight: 260,
            border: '2px dashed #007bff',
            borderRadius: 8,
            padding: 8,
            backgroundColor: '#f8f9fa'
          }}>
            {!joined && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#666'
              }}>
                Join a room to see other participants
              </div>
            )}
            {joined && participants.size === 0 && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#666'
              }}>
                Waiting for other participants...
              </div>
            )}
            {joined && participants.size > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {Array.from(participants.values()).map(participant => (
                  <VideoComponent
                    key={participant.sid}
                    track={participant.videoTrack}
                    participantId={participant.identity}
                    isLocal={false}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat Section */}
      <div style={{ marginBottom: 20 }}>
        <h3>Persistent Chat ({messages.length} messages)</h3>
        <div style={{
          border: '1px solid #dee2e6',
          padding: 12,
          height: 250,
          overflow: 'auto',
          backgroundColor: 'white',
          borderRadius: 8,
          marginBottom: 8
        }}>
          {messages.map((m, i) => (
            <div key={`${m.sid || m.username}-${m.ts}-${i}`} style={{
              marginBottom: 8,
              padding: 8,
              backgroundColor: m.username === username ? '#e3f2fd' : '#f5f5f5',
              borderRadius: 4,
              borderLeft: `3px solid ${m.username === username ? '#2196f3' : '#9e9e9e'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                <img 
                  src={m.avatarImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.username || 'User')}&background=007bff&color=fff&size=24&rounded=true`}
                  alt={`${m.username}'s avatar`}
                  style={{ 
                    width: 24, 
                    height: 24, 
                    borderRadius: '50%', 
                    marginRight: 8,
                    backgroundColor: '#f8f9fa'
                  }}
                  onError={(e) => {
                    e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(m.username || 'User')}&background=007bff&color=fff&size=24&rounded=true`;
                  }}
                />
                <div style={{ fontSize: '11px', color: '#666' }}>
                  <strong>{m.username}</strong> - {new Date(m.ts).toLocaleTimeString()}
                </div>
              </div>
              <div style={{ marginLeft: 32 }}>{m.text}</div>
            </div>
          ))}
          {messages.length === 0 && (
            <div style={{
              color: '#666',
              fontStyle: 'italic',
              textAlign: 'center',
              marginTop: 100,
              fontSize: '14px'
            }}>
              {conversationStatus === 'connected'
                ? 'No messages yet. Start the conversation!'
                : 'Connecting to chat...'}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="chatInput"
            placeholder={conversationStatus === 'connected' ? "Type your message here..." : "Connecting to chat..."}
            style={{
              flex: 1,
              padding: 10,
              border: '1px solid #dee2e6',
              borderRadius: 4,
              fontSize: '14px'
            }}
            onKeyPress={handleChatKeyPress}
            disabled={conversationStatus !== 'connected'}
          />
          <button
            onClick={sendMessage}
            disabled={conversationStatus !== 'connected'}
            style={{
              padding: '10px 20px',
              backgroundColor: conversationStatus === 'connected' ? '#28a745' : '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: conversationStatus === 'connected' ? 'pointer' : 'not-allowed'
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* Participants List */}
      {joined && (
        <div style={{ marginBottom: 20, padding: 16, backgroundColor: '#e9ecef', borderRadius: 8 }}>
          <h4>Connected Participants:</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span style={{
              padding: '4px 8px',
              backgroundColor: '#28a745',
              color: 'white',
              borderRadius: 4,
              fontSize: '12px'
            }}>
              You ({username}) - {userRole}
            </span>
            {Array.from(participants.values()).map(participant => (
              <span
                key={participant.sid}
                style={{
                  padding: '4px 8px',
                  backgroundColor: '#007bff',
                  color: 'white',
                  borderRadius: 4,
                  fontSize: '12px'
                }}
              >
                {participant.identity} - {participant.videoTrack ? 'Video' : 'Audio only'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Debug Information */}
      <details style={{ marginTop: 20 }}>
        <summary style={{
          cursor: 'pointer',
          padding: 8,
          backgroundColor: '#e9ecef',
          borderRadius: 4,
          userSelect: 'none'
        }}>
          🔍 Debug Information (Click to expand)
        </summary>
        <div style={{
          marginTop: 8,
          padding: 12,
          backgroundColor: '#f8f9fa',
          borderRadius: 4,
          fontSize: '12px',
          fontFamily: 'monospace',
          border: '1px solid #dee2e6'
        }}>
          <div><strong>App State:</strong></div>
          <div>• Connected: {joined ? 'Yes' : 'No'}</div>
          <div>• Video Status: {connectionStatus}</div>
          <div>• Chat Status: {conversationStatus}</div>
          <div>• User Role: {userRole || 'None'}</div>
          <div>• Avatar Image: {avatarImage || 'Using generated avatar'}</div>
          <div>• Participant Count: {participantCount}</div>
          <div>• Messages: {messages.length}</div>

          <div style={{ marginTop: 8 }}><strong>Twilio Objects:</strong></div>
          <div>• Room: {roomRef.current ? `Connected to "${roomRef.current.name}"` : 'Not connected'}</div>
          <div>• Conversations Client: {conversationsClientRef.current ? 'Active' : 'None'}</div>
          <div>• Conversation: {conversationRef.current ? 'Active' : 'None'}</div>
          <div>• Local Tracks: {localTracksRef.current.length}</div>
          <div>• Local Video Track: {localVideoTrack ? 'Active' : 'None'}</div>
          <div>• Video Elements: {videoElementsRef.current.size}</div>

          {roomRef.current && (
            <>
              <div style={{ marginTop: 8 }}><strong>Room Details:</strong></div>
              <div>• Local Participant SID: {roomRef.current.localParticipant.sid}</div>
              <div>• Remote Participants: {Array.from(roomRef.current.participants.keys()).join(', ') || 'None'}</div>
            </>
          )}

          {participants.size > 0 && (
            <>
              <div style={{ marginTop: 8 }}><strong>Participant Details:</strong></div>
              {Array.from(participants.values()).map(p => (
                <div key={p.sid}>• {p.identity} (SID: {p.sid}) - Video: {p.videoTrack ? 'Yes' : 'No'}</div>
              ))}
            </>
          )}

          {conversationRef.current && (
            <>
              <div style={{ marginTop: 8 }}><strong>Conversation Details:</strong></div>
              <div>• Conversation SID: {conversationRef.current.sid}</div>
              <div>• Conversation Status: {conversationRef.current.status}</div>
            </>
          )}
        </div>
      </details>

      {/* Instructions */}
      <div style={{ marginTop: 20, padding: 16, backgroundColor: '#cff4fc', borderRadius: 8, border: '1px solid #b6effb' }}>
        <h4>📋 How to Use:</h4>
        <div style={{ fontSize: '14px', lineHeight: '1.6' }}>
          <p><strong>Step 1:</strong> Enter your JWT token, username, and optionally an avatar URL</p>
          <p><strong>Step 2:</strong> Enter a room name (must be the same for broadcaster and viewers)</p>
          <p><strong>Step 3 (Broadcaster):</strong> Click "Join Room" - your camera will start broadcasting</p>
          <p><strong>Step 3 (Viewer):</strong> Click "Join Room" - you'll see the broadcaster's video</p>
          <p><strong>Step 4:</strong> Use the persistent chat to communicate - messages include your avatar!</p>

          <div style={{ marginTop: 12, padding: 8, backgroundColor: '#d1ecf1', borderRadius: 4 }}>
            <strong>✨ Avatar Features:</strong> 
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Avatar is loaded from your backend when joining a room</li>
              <li>Avatars appear next to all your chat messages</li>
              <li>Previous messages load with their original avatars</li>
              <li>Auto-generated fallback avatars if backend doesn't provide one</li>
            </ul>
          </div>

          <div style={{ marginTop: 8, padding: 8, backgroundColor: '#fff3cd', borderRadius: 4 }}>
            <strong>⚠️ Troubleshooting:</strong> If avatars don't load, they'll fallback to generated ones. Check the debug panel below for details.
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;