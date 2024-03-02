import React, { createContext, useContext, useEffect, useState } from 'react';
import {} from "firebase/app"
import { UseCamera } from '@/hooks/useCamera';
import * as services from '@/services/observations';
import { DocumentData, collection, onSnapshot, query } from 'firebase/firestore';
import { db } from 'src/FirebaseConfig'; 
import { AnimalName, ObservationSchema } from '@/services/schemas';
import { useUser } from './UserContext';

//distance between longitude and latitude of two points (in km)
const haversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => { 
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in kilometers
}

//returns the average location of the images, and a radius around that average location,
//that encapsulates all the points
const getLocationInfo = (images: UseCamera[]) => {
    const location = {radius: -1} as {latitude: number, longitude: number, radius: number};
    const centroid = images.reduce((acc, image) => {
        acc.latitude += image?.current?.exif?.GPSLatitude;
        acc.longitude += image?.current?.exif?.GPSLongitude;
        return acc;
    }, { latitude: 0, longitude: 0 });

    console.log(images[0]?.current?.exif?.GPSLatitude, images[0]?.current?.exif?.GPSLongitude)
    
    location.latitude = centroid.latitude / images.length;
    location.longitude = centroid.longitude / images.length;

    //if there is more than one location, need to calculate radius
    if (images.length > 1) {
        const radius = images.reduce((maxDistance, image) => {
            const distance = haversineDistance(
                centroid.latitude, centroid.longitude,
                image?.current?.exif?.GPSLatitude, image?.current?.exif?.GPSLongitude
            );
            return Math.max(maxDistance, distance);
        }, 0);
        //adjust threshold as needed
        if (radius > 0.1) location.radius = radius;
    }
    return location;
}

//returns the most recent timestamp of the images
const getMostRecentTimestamp = (images: UseCamera[]): Date => {
    return images
      .map(image => new Date(image.current?.exif?.timestamp))
      .reduce((mostRecent, current) => current < mostRecent ? current : mostRecent);
}

export type ImageToUpload = {
    uri: string;
    metadata: { [key: string]: any }; 
}

export type ObservationToUpload = {
    user: {
        refId: string;
        name: string;
    }
    animalName: AnimalName[];
    location: {
        latitude: number;
        longitude: number;
        radius: number;
    }
    timestamp: string;
    description: string;
    images: ImageToUpload[]
}


export interface IObservationsValue {
    //the id gets added in the onSnapshot
    data: (ObservationSchema & {id: string})[];
    add: (observation: {animalName: string, description: string, images: UseCamera[]}) => Promise<void>;
    isUploading: boolean;
}

const ObservationContext = createContext<Partial<IObservationsValue>>({});

export const ObservationProvider = ({ children }: { children: React.ReactNode }) => {
    const [observations, setObservations] = useState<(ObservationSchema & {id: string})[]>([]);
    const [isUploading, setIsUploading] = useState(false);

    const user = useUser();

    const add = async (
        {animalName, description, images}: 
        {animalName: string, description: string, images: UseCamera[]}
    ) => {
        setIsUploading(true);
        
        const formatUser = {
            refId: user.info?.uid,
            name: user?.info?.displayName
        }

        const animalId = await services.processAnimalName(animalName);

        const formatAnimalName = {
            refId: animalId, 
            name: animalName, 
            upvotes: 0
        } as AnimalName;

        const observation = {
            user: formatUser,
            animalName: [formatAnimalName], 
            description
        } as ObservationToUpload;
        
        //the images the user didn't leave blank 
        const filteredImages = images.filter(image => image.result !== undefined);
        //get the data in the right format to upload...
        observation.images = filteredImages.map(image => ({
            uri: image.current!.uri,
            metadata: {
                latitude: JSON.stringify(image.current?.exif?.GPSLatitude),
                longitude: JSON.stringify(image.current?.exif?.GPSLongitude),
            }
        }));
        observation.timestamp = getMostRecentTimestamp(filteredImages).toISOString();
        observation.location = getLocationInfo(filteredImages);
        //upload to firebase
        try{ 
            await services.addObservation(observation);
            setIsUploading(false);
        }catch(err){
           throw err;
        }
    }

    useEffect(() => {
        // Define the collection you want to listen to
        const collectionRef = collection(db, 'observations');
        // Optionally, you can apply query constraints here
        const q = query(collectionRef);
    
        // Subscribe to the collection
        const unsubscribe = onSnapshot(q, (snapshot) => {
          const updatedObservations = snapshot.docs.map(doc => ({
            id: doc.id,
            ...(doc.data() as DocumentData) as ObservationSchema,
          }));
          // Update state with the new observations
          setObservations(updatedObservations);
        });

        return () => unsubscribe();

    }, []);

    const value = {
        data: observations,
        isUploading,
        add
    };

    return (
        <ObservationContext.Provider value={value}>
            {children}
        </ObservationContext.Provider>
    )
};

export const useObservations = () => {
    return useContext(ObservationContext) as IObservationsValue;
}