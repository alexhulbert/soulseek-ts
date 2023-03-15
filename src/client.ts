import { Socket } from 'net'
import crypto from 'crypto'
import { parentPort } from 'worker_threads'
import { ConnectionType, UserStatus } from './messages/common'
import { FromServerMessage, Login } from './messages/from/server'
import { SlskPeer, SlskPeerEvents } from './peer'
import { ServerAddress, SlskServer } from './server'
import TypedEventEmitter from 'typed-emitter'
import EventEmitter from 'events'
import { FileSearchResponse, FromPeerMessage } from './messages/from/peer'

export const DEFAULT_LOGIN_TIMEOUT = 10 * 1000
export const DEFAULT_SEARCH_TIMEOUT = 10 * 1000

export type SlskPeersEvents = {
  message: (msg: FromPeerMessage, peer: SlskPeer) => void
}

export class SlskClient {
  server: SlskServer
  peers: Map<string, SlskPeer>
  peerMessages: TypedEventEmitter<SlskPeersEvents>

  constructor(
    serverAddress: ServerAddress = {
      host: 'server.slsknet.org',
      port: 2242,
    }
  ) {
    this.server = new SlskServer(serverAddress)
    this.peers = new Map()
    this.peerMessages = new EventEmitter() as TypedEventEmitter<SlskPeersEvents>

    this.server.on('message', (msg) => {
      switch (msg.kind) {
        case 'login': {
          this.server.send('sharedFoldersFiles', { dirs: 1, files: 1 })
          this.server.send('haveNoParents', { haveNoParents: true })
          this.server.send('setStatus', { status: UserStatus.Online })
          break
        }
        case 'possibleParents': {
          for (const parent of msg.parents) {
            this.server.send('searchParent', { host: parent.host })
          }
          break
        }
        case 'connectToPeer': {
          switch (msg.type) {
            case ConnectionType.PeerToPeer: {
              const existingPeer = this.peers.get(msg.username)
              if (existingPeer) {
                // We're already connected, ignore
                return
              }

              const peer = new SlskPeer({ host: msg.host, port: msg.port })

              peer.once('connect', () => {
                peer.send('pierceFirewall', { token: msg.token })
              })

              peer.once('error', () => {
                this.server.send('cantConnectToPeer', {
                  token: msg.token,
                  username: msg.username,
                })
              })

              peer.once('close', () => {
                peer.destroy()
                this.peers.delete(msg.username)
              })

              peer.on('message', (msg) =>
                this.peerMessages.emit('message', msg, peer)
              )

              this.peers.set(msg.username, peer)

              break
            }
            case ConnectionType.FileTransfer: {
              // TODO: Download file
              break
            }
            case ConnectionType.Distributed: {
              // TODO: Handle distributed peer
              break
            }
          }
        }
      }
    })
  }

  async login(
    username: string,
    password: string,
    timeout = DEFAULT_LOGIN_TIMEOUT
  ) {
    this.server.send('login', { username, password })

    const loginResult = await new Promise<Login>((resolve, reject) => {
      const timeout_ = setTimeout(() => {
        this.server.off('message', listener)
        reject(new Error('Login timed out'))
      }, timeout)

      const listener = (msg: FromServerMessage) => {
        if (msg.kind === 'login') {
          clearTimeout(timeout_)
          this.server.off('message', listener)
          resolve(msg)
        }
      }

      this.server.on('message', listener)
    })

    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.reason}`)
    }
  }

  search(
    query: string,
    {
      timeout = DEFAULT_SEARCH_TIMEOUT,
      onResult,
    }: {
      timeout?: number
      onResult?: (result: FileSearchResponse) => void
    } = {}
  ) {
    // generate a token to identify the search
    const token = crypto.randomBytes(4).toString('hex')

    // send the search request
    this.server.send('fileSearch', { token, query })

    // listen for results. call the onResult callback for each result
    const results: FileSearchResponse[] = []
    const listener = (msg: FromPeerMessage) => {
      if (msg.kind === 'fileSearchResponse' && msg.token === token) {
        onResult?.(msg)
        results.push(msg)
      }
    }
    this.peerMessages.on('message', listener)

    // after the search times out, stop listening for results
    return new Promise((resolve) => {
      setTimeout(() => {
        this.peerMessages.off('message', listener)
        resolve(results)
      }, timeout)
    })
  }

  destroy() {
    this.server.destroy()
    for (const peer of this.peers.values()) {
      peer.destroy()
    }
  }
}
