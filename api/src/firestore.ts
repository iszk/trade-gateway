import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

export const getFirestoreClient = (): Firestore => {
    if (getApps().length === 0) {
        initializeApp()
    }
    return getFirestore()
}
