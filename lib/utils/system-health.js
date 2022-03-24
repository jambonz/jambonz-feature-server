export async function systemHealth(redisClient, mySqlClient, activeCalls, srfHealthy) {
    return async () => {
      await Promise.all([redisClient.ping(), mySqlClient.ping()]);
  
      if (!srfHealthy) {
        throw new Error("Signalling server disconnected!");
      }
    
      return activeCalls;      
    }

  }